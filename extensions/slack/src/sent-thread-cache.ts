import { resolveGlobalMap } from "openclaw/plugin-sdk/text-core";

/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");

let threadParticipation: Map<string, number> | undefined;

function getThreadParticipation(): Map<string, number> {
  threadParticipation ??= resolveGlobalMap<string, number>(SLACK_THREAD_PARTICIPATION_KEY);
  return threadParticipation;
}

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of getThreadParticipation()) {
    if (now - timestamp > TTL_MS) {
      getThreadParticipation().delete(key);
    }
  }
}

function evictOldest(): void {
  const oldest = getThreadParticipation().keys().next().value;
  if (oldest) {
    getThreadParticipation().delete(oldest);
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  const threadParticipation = getThreadParticipation();
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictExpired();
  }
  if (threadParticipation.size >= MAX_ENTRIES) {
    evictOldest();
  }
  threadParticipation.set(makeKey(accountId, channelId, threadTs), Date.now());
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  const key = makeKey(accountId, channelId, threadTs);
  const threadParticipation = getThreadParticipation();
  const timestamp = threadParticipation.get(key);
  if (timestamp == null) {
    return false;
  }
  if (Date.now() - timestamp > TTL_MS) {
    threadParticipation.delete(key);
    return false;
  }
  return true;
}

export function clearSlackThreadParticipationCache(): void {
  getThreadParticipation().clear();
}
