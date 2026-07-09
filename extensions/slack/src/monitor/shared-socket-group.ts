// Slack plugin module implements shared Socket Mode group behavior.
//
// Slack delivers Socket Mode events to exactly one of the open connections for
// a given app (it load-balances across connections, it does not fan events
// out to all of them). When the SAME Slack app (identified by its app token)
// is installed into multiple workspaces and configured as multiple OpenClaw
// accounts, opening one Socket Mode connection per account means Slack picks
// a single connection per event and roughly half the traffic lands on an
// account whose `shouldDropMismatchedSlackEvent` team/app filter throws it
// away — the other workspace's events are silently lost.
//
// The fix is to open exactly one Socket Mode connection (one Bolt App) per
// distinct app token, and register every sharing account's event handlers on
// that single App. Bolt invokes every registered listener for a matching
// event, so the existing per-account `shouldDropMismatchedSlackEvent` filter
// already demultiplexes correctly once handlers from multiple accounts sit on
// the same App.
//
// This module tracks that sharing at the process level: the first account to
// reference a given app token creates the App and becomes the group's
// creator; every later account with the same app token joins as a member and
// reuses that App/receiver instead of opening a second socket.
//
// The connection itself runs as a GROUP-OWNED task (startConnectionTask),
// deliberately decoupled from any single account's lifecycle: every sharing
// account — creator included — just registers handlers and then waits
// passively on its own abort signal, so a per-account stop resolves that
// account's monitor promise immediately (the gateway stops accounts
// independently; see src/gateway/server-channels.ts) while the shared socket
// keeps serving the remaining accounts. Membership is reference-counted; the
// group, and with it the connection task, ends only after every member has
// left — regardless of which member leaves last.
import {
  computeBackoff,
  sleepWithAbort,
  warn,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { createSlackTokenCacheKey } from "../client.js";
import {
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketReconnectMessage,
  formatSlackSocketStartRetryMessage,
  formatUnknownError,
  isNonRecoverableSlackAuthError,
  SLACK_SOCKET_RECONNECT_POLICY,
} from "./reconnect-policy.js";

const SLACK_SHARED_SOCKET_GROUPS_KEY = Symbol.for("openclaw.slack.sharedSocketGroups");

type SlackSharedSocketGroupState<TAppBundle> = {
  key: string;
  ownerAccountId: string;
  memberAccountIds: Set<string>;
  appBundlePromise: Promise<TAppBundle>;
  stopController: AbortController;
  connectionTaskStarted: boolean;
  // Fatal error that tore the group down (e.g. a non-recoverable auth
  // failure in the connection task). Recorded before stopSignal fires so
  // accounts waking from their passive wait can rethrow it.
  stopError?: unknown;
};

type SlackSharedSocketGroupRegistry = Map<string, SlackSharedSocketGroupState<unknown>>;

function registryMap(): SlackSharedSocketGroupRegistry {
  const proc = process as NodeJS.Process & {
    [SLACK_SHARED_SOCKET_GROUPS_KEY]?: SlackSharedSocketGroupRegistry;
  };
  proc[SLACK_SHARED_SOCKET_GROUPS_KEY] ??= new Map();
  return proc[SLACK_SHARED_SOCKET_GROUPS_KEY];
}

export type SlackSharedSocketGroupHandle<TAppBundle> = {
  /** The Bolt App/receiver bundle to register listeners on. */
  appBundle: TAppBundle;
  /** True if this account created the group (and starts the connection task). */
  isOwner: boolean;
  /** True the moment a second account joins an existing solo group (log-once signal). */
  justBecameShared: boolean;
  /** Total accounts currently sharing this app token. */
  memberCount: number;
  /**
   * Aborts once every member account has left the group, the connection task
   * ended (fatally or not), or a force-stop tore the group down. Every
   * account's passive wait keys off this signal alongside its own abort
   * signal.
   */
  stopSignal: AbortSignal;
  /** Fatal error that ended the group's connection task, if any. */
  getStopError: () => unknown;
  /**
   * Starts the group-owned connection task (the creator calls this once,
   * after registering its handlers). The task's lifetime belongs to the
   * GROUP, not the calling account: it keeps running after the creator's own
   * account is stopped, for as long as any member remains. When the task
   * ends — fatally or because stopSignal fired — the group is torn down so
   * every member's passive wait resolves. Idempotent; extra calls are
   * ignored.
   */
  startConnectionTask: (run: () => Promise<void>) => void;
  /** True once startConnectionTask has been called for this group. */
  hasConnectionTask: () => boolean;
  /** Removes this account from the group; aborts stopSignal if it was last. */
  leave: () => void;
};

function teardownGroup(state: SlackSharedSocketGroupState<unknown>): void {
  const reg = registryMap();
  if (reg.get(state.key) === state) {
    reg.delete(state.key);
  }
  state.stopController.abort();
}

function buildGroupHandle<TAppBundle>(params: {
  state: SlackSharedSocketGroupState<unknown>;
  appBundle: TAppBundle;
  accountId: string;
  isOwner: boolean;
  justBecameShared: boolean;
}): SlackSharedSocketGroupHandle<TAppBundle> {
  const { state } = params;
  return {
    appBundle: params.appBundle,
    isOwner: params.isOwner,
    justBecameShared: params.justBecameShared,
    memberCount: state.memberAccountIds.size,
    stopSignal: state.stopController.signal,
    getStopError: () => state.stopError,
    startConnectionTask: (run) => {
      if (state.connectionTaskStarted) {
        return;
      }
      state.connectionTaskStarted = true;
      void (async () => {
        try {
          await run();
        } catch (err) {
          state.stopError = err ?? new Error("Slack shared socket task failed without detail");
        } finally {
          // Whatever ended the task (fatal error, or stopSignal firing after
          // the last member left), make the teardown observable: members
          // must never keep waiting on a group whose connection is gone.
          teardownGroup(state);
        }
      })();
    },
    hasConnectionTask: () => state.connectionTaskStarted,
    leave: () => leaveGroup(state.key, params.accountId),
  };
}

/**
 * Joins (or creates) the shared Socket Mode group for `appToken`. Concurrent
 * joins for the same app token are race-free: the registry slot is reserved
 * synchronously before `createAppBundle` is awaited, so a second account
 * arriving while the first account's App is still being constructed will
 * always see the in-flight reservation and await the same instance rather
 * than creating a competing one.
 */
export async function joinSlackSharedSocketGroup<TAppBundle>(params: {
  appToken: string;
  accountId: string;
  createAppBundle: () => Promise<TAppBundle>;
}): Promise<SlackSharedSocketGroupHandle<TAppBundle>> {
  const key = createSlackTokenCacheKey(params.appToken);
  const reg = registryMap();
  const existing = reg.get(key);

  if (existing) {
    existing.memberAccountIds.add(params.accountId);
    const appBundle = (await existing.appBundlePromise) as TAppBundle;
    return buildGroupHandle({
      state: existing,
      appBundle,
      accountId: params.accountId,
      isOwner: false,
      justBecameShared: existing.memberAccountIds.size === 2,
    });
  }

  const stopController = new AbortController();
  const appBundlePromise = params.createAppBundle();
  const state: SlackSharedSocketGroupState<unknown> = {
    key,
    ownerAccountId: params.accountId,
    memberAccountIds: new Set<string>([params.accountId]),
    appBundlePromise,
    stopController,
    connectionTaskStarted: false,
  };
  reg.set(key, state);

  let appBundle: TAppBundle;
  try {
    appBundle = await appBundlePromise;
  } catch (err) {
    // Creation failed before anyone else could observe it: release the
    // reservation so a subsequent attempt (e.g. after a config fix) can retry
    // cleanly instead of being stuck awaiting a permanently-rejected promise.
    teardownGroup(state);
    throw err;
  }

  return buildGroupHandle({
    state,
    appBundle,
    accountId: params.accountId,
    isOwner: true,
    justBecameShared: false,
  });
}

function leaveGroup(key: string, accountId: string): void {
  const reg = registryMap();
  const existing = reg.get(key);
  if (!existing) {
    return;
  }
  existing.memberAccountIds.delete(accountId);
  if (existing.memberAccountIds.size === 0) {
    teardownGroup(existing);
  }
}

/**
 * Unconditionally tears down the group for `appToken`, aborting `stopSignal`
 * regardless of remaining membership. Backstop for the group creator's error
 * paths BEFORE the connection task exists (once the task runs, its own
 * finally performs the teardown): without it, a creator that throws between
 * joining and starting the task would leave members waiting forever on a
 * stopSignal nobody will ever fire.
 */
export function forceStopSlackSharedSocketGroup(params: { appToken: string }): void {
  const key = createSlackTokenCacheKey(params.appToken);
  const existing = registryMap().get(key);
  if (!existing) {
    return;
  }
  teardownGroup(existing);
}

/**
 * Runs one Slack Socket Mode connection with the standard reconnect/backoff
 * policy until `abortSignal` fires or a non-recoverable auth error is hit
 * (which is rethrown to the caller). Used both by the group-owned shared
 * connection task and by solo (non-shared) accounts; the caller owns the
 * final `gracefulStopSlackApp` for its App.
 */
export async function runSlackSocketConnectionLoop(params: {
  app: { start: () => unknown; stop: () => unknown };
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  setStatus?: (next: Record<string, unknown>) => void;
  getLastSdkLogMessage?: () => string | undefined;
}): Promise<void> {
  const { app, abortSignal, runtime } = params;
  let reconnectAttempts = 0;
  let hasLoggedSocketConnected = false;
  // abortSignal itself never gets reassigned, but its .aborted getter flips
  // when abort() fires externally (an account's own stop signal, or the
  // shared group's stop signal).
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  while (!abortSignal?.aborted) {
    try {
      const disconnect = await startSlackSocketAndWaitForDisconnect({
        app,
        abortSignal,
        onStarted: () => {
          reconnectAttempts = 0;
          publishSlackConnectedStatus(params.setStatus);
          if (!hasLoggedSocketConnected) {
            hasLoggedSocketConnected = true;
            runtime.log?.("slack socket mode connected");
          }
        },
      });
      if (!disconnect) {
        break;
      }
      if (abortSignal?.aborted) {
        break;
      }
      publishSlackDisconnectedStatus(params.setStatus, disconnect.error);

      // Permanent account and credential failures need operator action.
      if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
        runtime.error?.(
          `slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`,
        );
        throw disconnect.error instanceof Error
          ? disconnect.error
          : new Error(formatUnknownError(disconnect.error));
      }

      reconnectAttempts += 1;
      const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
      runtime.log?.(
        warn(
          formatSlackSocketReconnectMessage({
            event: disconnect.event,
            attempt: reconnectAttempts,
            delayMs,
            error: disconnect.error,
          }),
        ),
      );
      await gracefulStopSlackApp(app);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch {
        break;
      }
    } catch (err) {
      if (isNonRecoverableSlackAuthError(err)) {
        runtime.error?.(
          `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
        );
        throw err;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
      runtime.error?.(
        formatSlackSocketStartRetryMessage({
          attempt: reconnectAttempts,
          delayMs,
          error: err,
          sdkContext: params.getLastSdkLogMessage?.(),
        }),
      );
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch {
        break;
      }
      continue;
    }
  }
}

export function resetSlackSharedSocketGroupsForTests(): void {
  registryMap().clear();
}
