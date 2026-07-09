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
// reference a given app token creates the App and becomes its "owner" for the
// lifetime of the group; every later account with the same app token joins as
// a member and reuses the owner's App/receiver instead of opening a second
// socket. Membership is reference-counted so the shared App is stopped
// exactly once, only after every member has left the group — regardless of
// which member (owner or not) happens to leave last, and regardless of
// whether the owner's own account is stopped independently while other
// members are still running (each account has its own AbortController; see
// src/gateway/server-channels.ts).
import { createSlackTokenCacheKey } from "../client.js";

const SLACK_SHARED_SOCKET_GROUPS_KEY = Symbol.for("openclaw.slack.sharedSocketGroups");

type SlackSharedSocketGroupState<TAppBundle> = {
  key: string;
  ownerAccountId: string;
  memberAccountIds: Set<string>;
  appBundlePromise: Promise<TAppBundle>;
  stopController: AbortController;
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
  /** The Bolt App/receiver bundle to register listeners on and (owner only) start/stop. */
  appBundle: TAppBundle;
  /** True if this account created the group (and therefore owns start/stop). */
  isOwner: boolean;
  /** True the moment a second account joins an existing solo group (log-once signal). */
  justBecameShared: boolean;
  /** Total accounts currently sharing this app token. */
  memberCount: number;
  /**
   * Aborts once every member account has left the group (or the owner forces
   * a teardown). The owner's connect/reconnect loop should key off this
   * signal instead of its own individual account abortSignal so the shared
   * socket stays open for as long as ANY member still needs it.
   */
  stopSignal: AbortSignal;
  /** Removes this account from the group; aborts stopSignal if it was last. */
  leave: () => void;
};

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
    const memberCount = existing.memberAccountIds.size;
    return {
      appBundle,
      isOwner: false,
      justBecameShared: memberCount === 2,
      memberCount,
      stopSignal: existing.stopController.signal,
      leave: () => leaveGroup(key, params.accountId),
    };
  }

  const memberAccountIds = new Set<string>([params.accountId]);
  const stopController = new AbortController();
  const appBundlePromise = params.createAppBundle();
  const state: SlackSharedSocketGroupState<unknown> = {
    key,
    ownerAccountId: params.accountId,
    memberAccountIds,
    appBundlePromise,
    stopController,
  };
  reg.set(key, state);

  let appBundle: TAppBundle;
  try {
    appBundle = await appBundlePromise;
  } catch (err) {
    // Creation failed before anyone else could observe it: release the
    // reservation so a subsequent attempt (e.g. after a config fix) can retry
    // cleanly instead of being stuck awaiting a permanently-rejected promise.
    if (reg.get(key) === state) {
      reg.delete(key);
    }
    throw err;
  }

  return {
    appBundle,
    isOwner: true,
    justBecameShared: false,
    memberCount: memberAccountIds.size,
    stopSignal: stopController.signal,
    leave: () => leaveGroup(key, params.accountId),
  };
}

function leaveGroup(key: string, accountId: string): void {
  const reg = registryMap();
  const existing = reg.get(key);
  if (!existing) {
    return;
  }
  existing.memberAccountIds.delete(accountId);
  if (existing.memberAccountIds.size === 0) {
    reg.delete(key);
    existing.stopController.abort();
  }
}

/**
 * Unconditionally tears down the group for `appToken`, aborting `stopSignal`
 * regardless of remaining membership. Intended as a backstop the owner calls
 * on its own way out (including on a thrown/fatal error) so members can never
 * be left waiting forever on a group whose owner coroutine has already
 * stopped running the shared connection.
 */
export function forceStopSlackSharedSocketGroup(params: { appToken: string }): void {
  const key = createSlackTokenCacheKey(params.appToken);
  const reg = registryMap();
  const existing = reg.get(key);
  if (!existing) {
    return;
  }
  reg.delete(key);
  existing.stopController.abort();
}

export function resetSlackSharedSocketGroupsForTests(): void {
  registryMap().clear();
}
