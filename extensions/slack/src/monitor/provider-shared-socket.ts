// Slack plugin module implements the provider-level policy layer on top of
// shared-socket-group.ts's group primitives: deciding whether an account
// should join a shared Socket Mode group, resolving its App bundle
// accordingly, logging the boot-time warnings that decision produces, running
// the connection with the right shared/solo semantics, and settling
// membership on exit. Split out of provider.ts (which must stay at or under
// its ratcheted line budget) as its own module.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { listEnabledSlackAccounts } from "../accounts.js";
import { gracefulStopSlackApp } from "./provider-support.js";
import { formatUnknownError } from "./reconnect-policy.js";
import {
  forceStopSlackSharedSocketGroup,
  joinSlackSharedSocketGroup,
  runSlackSocketConnectionLoop,
  type SlackSharedSocketGroupHandle,
} from "./shared-socket-group.js";

/**
 * Counts enabled Socket Mode accounts (across the whole `channels.slack`
 * config, not just the account currently booting) that resolve to the same
 * app token as `appToken`. Grouping into a shared Socket Mode connection is
 * only engaged when this is greater than 1 — a single account per app token
 * takes the original, unmodified code path with zero behavioral change.
 *
 * Enterprise Grid org installs are excluded: they resolve teamId as ""
 * (resolveSlackInstallationIdentity's "enterprise" kind never carries a
 * teamId), so they can never pass shouldDropMismatchedSlackEvent's per-event
 * team_id demux once inside a shared group — every inbound event would be
 * dropped fail-closed. They always take the dedicated, non-shared connection
 * regardless of how many siblings share their app token, so they must not
 * count toward (or be counted as) a sharing group.
 */
function countEnabledSlackSocketAccountsSharingAppToken(params: {
  cfg: OpenClawConfig;
  appToken: string;
}): number {
  return listEnabledSlackAccounts(params.cfg).filter((candidate) => {
    const mode = candidate.config.mode ?? "socket";
    return (
      mode === "socket" &&
      candidate.appToken === params.appToken &&
      candidate.config.enterpriseOrgInstall !== true
    );
  }).length;
}

/**
 * Decides whether this account's Socket Mode connection should be shared
 * with sibling accounts on the same app token.
 *
 * Slack Socket Mode delivers each event to exactly one open connection for an
 * app (it load-balances, it does not fan out). If two accounts open two
 * Socket Mode connections for the SAME app token, each drops ~half the
 * traffic via shouldDropMismatchedSlackEvent's team_id filter. Detect that
 * configuration up front (purely from static config, so every sibling
 * account computes the same answer) and, only then, share a single Bolt
 * App/connection across all of them. A single account per app token takes
 * the untouched original code path (resolveSlackSocketAppBundle's solo
 * branch) with no behavioral change.
 *
 * Enterprise Grid org installs are excluded from sharing (see
 * countEnabledSlackSocketAccountsSharingAppToken): their teamId always
 * resolves to "", which would make the shared group's fail-closed
 * unresolved-teamId guard drop every inbound event for them. They keep using
 * this dedicated, non-shared connection even if a sibling account reuses the
 * same app token.
 */
export function resolveSlackSharedSocketGroupParticipation(params: {
  cfg: OpenClawConfig;
  enterpriseOrgInstall: boolean;
  slackMode: string;
  appToken?: string;
}): {
  isSharedSlackSocketAppToken: boolean;
  enterpriseExcludedFromSharedSocketGroup: boolean;
} {
  const { cfg, enterpriseOrgInstall, slackMode, appToken } = params;
  const isSharedSlackSocketAppToken =
    !enterpriseOrgInstall &&
    slackMode === "socket" &&
    Boolean(appToken) &&
    countEnabledSlackSocketAccountsSharingAppToken({ cfg, appToken: appToken ?? "" }) > 1;
  // True when this enterprise account's app token IS shared by other
  // (non-enterprise) accounts — i.e. it would have joined a shared group were
  // it not an enterprise install. Drives a single boot-time warning so the
  // dedicated-connection fallback above is not silent.
  const enterpriseExcludedFromSharedSocketGroup =
    enterpriseOrgInstall &&
    slackMode === "socket" &&
    Boolean(appToken) &&
    countEnabledSlackSocketAccountsSharingAppToken({ cfg, appToken: appToken ?? "" }) > 0;
  return { isSharedSlackSocketAppToken, enterpriseExcludedFromSharedSocketGroup };
}

/**
 * Builds the graceful-stop callback for an account's Bolt App.
 *
 * Pre-sets shuttingDown on the SocketModeClient before app.stop() to prevent
 * a race where the library's internal ping timeout fires disconnect() before
 * shuttingDown is set, causing orphaned reconnects with leaked ping
 * intervals. See: openclaw/openclaw#56508
 *
 * When `sharedGroup` is set, this is a no-op: the group-owned connection
 * task stops the shared App; individual accounts (creator included) never
 * stop an App siblings may be using.
 */
export function createSlackGracefulStop<TAppBundle>(params: {
  app: { stop: () => unknown };
  sharedGroup: SlackSharedSocketGroupHandle<TAppBundle> | null;
}): () => Promise<void> {
  return async () => {
    if (params.sharedGroup) {
      return;
    }
    await gracefulStopSlackApp(params.app);
  };
}

/**
 * Warns once, at boot, when this account is in a shared Socket Mode group but
 * its teamId never resolved (auth.test failed or returned no team_id). On a
 * shared App every event for this account will be dropped fail-closed (see
 * shouldDropMismatchedSlackEvent) to avoid acting on sibling workspaces'
 * traffic, so the operator needs to know to fix the bot token and restart.
 */
export function warnSlackSharedSocketGroupUnresolvedTeamId(params: {
  isSharedSlackSocketAppToken: boolean;
  teamId: string;
  accountId: string;
  runtime: RuntimeEnv;
}): void {
  if (!params.isSharedSlackSocketAppToken || params.teamId) {
    return;
  }
  params.runtime.log?.(
    warn(
      `[${params.accountId}] slack: teamId unresolved on a shared socket group (auth.test failed or returned no team_id); ` +
        "ALL events for this account will be dropped to avoid acting on sibling workspaces' traffic — " +
        "fix the bot token and restart",
    ),
  );
}

/**
 * Resolves the Bolt App/receiver bundle an account should use: joins the
 * shared Socket Mode group when `isSharedSlackSocketAppToken` is set, or
 * creates a dedicated (solo) bundle otherwise — the untouched original code
 * path, with no behavioral change for accounts that don't share an app
 * token.
 */
export async function resolveSlackSocketAppBundle<TAppBundle>(params: {
  isSharedSlackSocketAppToken: boolean;
  appToken?: string;
  accountId: string;
  createSharedAppBundle: () => Promise<TAppBundle>;
  createSoloAppBundle: () => Promise<TAppBundle>;
}): Promise<{
  appBundle: TAppBundle;
  sharedGroup: SlackSharedSocketGroupHandle<TAppBundle> | null;
}> {
  if (params.isSharedSlackSocketAppToken) {
    const sharedGroup = await joinSlackSharedSocketGroup<TAppBundle>({
      appToken: params.appToken as string,
      accountId: params.accountId,
      createAppBundle: params.createSharedAppBundle,
    });
    return { appBundle: sharedGroup.appBundle, sharedGroup };
  }
  return { appBundle: await params.createSoloAppBundle(), sharedGroup: null };
}

/**
 * Logs the boot-time warnings tied to shared Socket Mode group participation:
 * the log-once "sharing socket" message when a solo group just became
 * shared, and the enterprise-org-excluded notice. Must be called from inside
 * the caller's try block: runtime.log is caller-supplied and may throw, and
 * an account that dies here must still leave the group / unwind cleanly
 * through the caller's existing finally.
 */
export function logSlackSharedSocketGroupBootWarnings<TAppBundle>(params: {
  sharedGroup: SlackSharedSocketGroupHandle<TAppBundle> | null;
  enterpriseExcludedFromSharedSocketGroup: boolean;
  cfg: OpenClawConfig;
  appToken?: string;
  expectedApiAppIdFromAppToken?: string;
  accountId: string;
  runtime: RuntimeEnv;
}): void {
  const { sharedGroup, runtime } = params;
  if (sharedGroup?.justBecameShared) {
    const sharedAccountCount = countEnabledSlackSocketAccountsSharingAppToken({
      cfg: params.cfg,
      appToken: params.appToken ?? "",
    });
    runtime.log?.(
      `slack: sharing socket for ${sharedAccountCount} accounts on app ` +
        `${params.expectedApiAppIdFromAppToken ?? "unknown"} (multi-workspace)`,
    );
  }

  if (params.enterpriseExcludedFromSharedSocketGroup) {
    runtime.log?.(
      warn(
        `slack account ${params.accountId}: enterprise org install cannot join a shared Socket Mode group; using a dedicated connection`,
      ),
    );
  }
}

/**
 * Runs (or joins) the Slack Socket Mode connection for an account, respecting
 * shared-group semantics when `sharedGroup` is set:
 *
 * - The group creator starts the connection as a GROUP-owned task, decoupled
 *   from this account's lifecycle: it keeps serving sibling accounts after
 *   this creator account is stopped, and only ends once every member has left
 *   (or a fatal error kills it). It intentionally keeps using the CREATOR's
 *   runtime for logs and the creator's setStatus for connection status even
 *   after the creator account itself stops.
 * - Every sharing account — creator included — waits passively until its OWN
 *   abort signal fires (per-account stop resolves this monitor promise
 *   immediately; the shared socket lives on for siblings) or the group's
 *   stopSignal fires (last member left, or the connection task died). Both
 *   listeners are removed on settle so neither signal accumulates stale
 *   callbacks.
 * - A fatal connection-task failure (e.g. non-recoverable auth error) is
 *   surfaced on every sharing account's monitor promise — unless this
 *   account was stopped on purpose, in which case it exits cleanly.
 *
 * When `sharedGroup` is null (solo account), this degrades to a plain
 * `runSlackSocketConnectionLoop` call with no behavioral change.
 */
export async function runSlackSocketModeConnectionForAccount<TAppBundle>(params: {
  app: { start: () => unknown; stop: () => unknown };
  sharedGroup: SlackSharedSocketGroupHandle<TAppBundle> | null;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  setStatus?: (next: Record<string, unknown>) => void;
  getLastSdkLogMessage?: () => string | undefined;
}): Promise<void> {
  const { app, sharedGroup, abortSignal, runtime } = params;
  if (!sharedGroup) {
    await runSlackSocketConnectionLoop({
      app,
      abortSignal,
      runtime,
      setStatus: params.setStatus,
      getLastSdkLogMessage: params.getLastSdkLogMessage,
    });
    return;
  }

  if (sharedGroup.isOwner) {
    sharedGroup.startConnectionTask(async () => {
      // Pre-set shuttingDown as soon as the group stops (same race guard as
      // the caller's own stopOnAbort, but keyed to the group's lifetime).
      const stopOnGroupStop = () => {
        void gracefulStopSlackApp(app);
      };
      sharedGroup.stopSignal.addEventListener("abort", stopOnGroupStop, { once: true });
      try {
        await runSlackSocketConnectionLoop({
          app,
          abortSignal: sharedGroup.stopSignal,
          runtime,
          setStatus: params.setStatus,
          getLastSdkLogMessage: params.getLastSdkLogMessage,
        });
      } finally {
        sharedGroup.stopSignal.removeEventListener("abort", stopOnGroupStop);
        await gracefulStopSlackApp(app);
      }
    });
  }
  if (!abortSignal?.aborted && !sharedGroup.stopSignal.aborted) {
    await new Promise<void>((resolve) => {
      const settle = () => {
        abortSignal?.removeEventListener("abort", settle);
        sharedGroup.stopSignal.removeEventListener("abort", settle);
        resolve();
      };
      abortSignal?.addEventListener("abort", settle, { once: true });
      sharedGroup.stopSignal.addEventListener("abort", settle, { once: true });
    });
  }
  const stopError = sharedGroup.getStopError();
  if (stopError !== undefined && !abortSignal?.aborted) {
    throw stopError instanceof Error ? stopError : new Error(formatUnknownError(stopError));
  }
}

/**
 * Settles this account's shared-group membership on exit (from the caller's
 * `finally`). If this account created the group but threw before the
 * connection task existed, tears the group down so members are never left
 * waiting forever on a stopSignal nobody will fire — once the task runs, its
 * own finally performs the teardown and a plain leave() is correct even for
 * the creator. A no-op when `sharedGroup` is null (solo account).
 */
export function settleSlackSharedSocketGroupMembership<TAppBundle>(params: {
  sharedGroup: SlackSharedSocketGroupHandle<TAppBundle> | null;
  appToken: string;
}): void {
  const { sharedGroup, appToken } = params;
  if (!sharedGroup) {
    return;
  }
  if (sharedGroup.isOwner && !sharedGroup.hasConnectionTask()) {
    forceStopSlackSharedSocketGroup({ appToken });
  } else {
    sharedGroup.leave();
  }
}
