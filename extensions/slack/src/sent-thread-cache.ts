import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 */

const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const MAX_FAILURE_NOTICES = 1000;
const PERSISTENT_NAMESPACE = "slack.thread-participation";

type SlackThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const SLACK_THREAD_FAILURE_NOTICES_KEY = Symbol.for("openclaw.slackThreadFailureNotices");
const threadParticipation = createPersistentDedupeCache<SlackThreadParticipationRecord>({
  globalKey: SLACK_THREAD_PARTICIPATION_KEY,
  // Participation remains valid until bounded oldest-entry eviction removes it.
  ttlMs: 0,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalSlackRuntime()?.state.openKeyedStore(options),
    logError: createPluginStateErrorReporter(
      getOptionalSlackRuntime,
      "slack",
      "thread-participation-state",
      "Slack persistent thread participation state failed",
    ),
  },
});
const threadFailureNotices = resolveGlobalSingleton(
  SLACK_THREAD_FAILURE_NOTICES_KEY,
  () => new Map<string, string>(),
  (notices) => notices.clear(),
);

function makeKey(accountId: string, channelId: string, threadTs: string, teamId?: string): string {
  return `${accountId}:${teamId ? `${teamId}:` : ""}${channelId}:${threadTs}`;
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  opts?: { agentId?: string; teamId?: string },
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  void threadParticipation.register(makeKey(accountId, channelId, threadTs, opts?.teamId), {
    // Stored for future per-agent thread routing; current reads only need presence.
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    repliedAt: Date.now(),
  });
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  teamId?: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs, teamId));
}

export async function hasSlackThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  teamId?: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return false;
  }
  return await threadParticipation.lookup(
    makeKey(params.accountId, params.channelId, params.threadTs, params.teamId),
  );
}

/**
 * Team id used when recording participation from an inbound turn.
 * Enterprise events keep their event-scope workspace; other inbound paths
 * use the monitor workspace so the key matches `send.ts` `delivery.teamId`.
 */
export function resolveSlackParticipationTeamId(params: {
  eventTeamId?: string;
  workspaceTeamId?: string;
}): string | undefined {
  return params.eventTeamId || params.workspaceTeamId || undefined;
}

function resolveInboundParticipationTeamIds(params: {
  eventTeamId?: string;
  workspaceTeamId?: string;
}): Array<string | undefined> {
  const eventTeamId = params.eventTeamId || undefined;
  if (eventTeamId) {
    return [eventTeamId];
  }
  const workspaceTeamId = params.workspaceTeamId || undefined;
  return workspaceTeamId ? [undefined, workspaceTeamId] : [undefined];
}

/**
 * Inbound mention gating looks up the same thread the bot already joined.
 * A named enterprise event scope stays exclusive. When that scope is absent
 * (relay / non-enterprise), also accept the monitor workspace id because
 * outbound send records `delivery.teamId` even without an inbound event scope.
 */
export function hasInboundSlackThreadParticipation(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  eventTeamId?: string;
  workspaceTeamId?: string;
}): boolean {
  return resolveInboundParticipationTeamIds(params).some((teamId) =>
    hasSlackThreadParticipation(params.accountId, params.channelId, params.threadTs, teamId),
  );
}

export async function hasInboundSlackThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  eventTeamId?: string;
  workspaceTeamId?: string;
}): Promise<boolean> {
  for (const teamId of resolveInboundParticipationTeamIds(params)) {
    if (
      await hasSlackThreadParticipationWithPersistence({
        accountId: params.accountId,
        channelId: params.channelId,
        threadTs: params.threadTs,
        teamId,
      })
    ) {
      return true;
    }
  }
  return false;
}

type SlackFailureNotice = {
  accountId: string;
  channelId: string;
  threadTs?: string;
  failureText: string;
  teamId?: string;
};

function makeFailureNoticeKey(params: Omit<SlackFailureNotice, "failureText">): string {
  const scope = params.threadTs ? `thread:${params.threadTs}` : "channel";
  return makeKey(params.accountId, params.channelId, scope, params.teamId);
}

/** Returns whether this failure was already delivered in the thread or channel. */
export function hasSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  return threadFailureNotices.get(makeFailureNoticeKey(params)) === fingerprint;
}

/** Records a failure after it was delivered in the thread or channel. */
export function recordSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  const key = makeFailureNoticeKey(params);
  if (threadFailureNotices.get(key) === fingerprint) {
    return false;
  }
  threadFailureNotices.delete(key);
  threadFailureNotices.set(key, fingerprint);
  pruneMapToMaxSize(threadFailureNotices, MAX_FAILURE_NOTICES);
  return true;
}

/** Clears a thread or channel outage notice after a healthy model turn completes. */
export function clearSlackThreadFailureNotice(params: {
  accountId: string;
  channelId: string;
  threadTs?: string;
  teamId?: string;
}): void {
  const { accountId, channelId } = params;
  if (!accountId || !channelId) {
    return;
  }
  threadFailureNotices.delete(makeFailureNoticeKey(params));
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clearForTest();
  threadFailureNotices.clear();
}
