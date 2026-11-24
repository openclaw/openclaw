import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  isAcpSessionKey,
  isCronRunSessionKey,
  isSubagentSessionKey,
} from "../sessions/session-key-utils.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/**
 * Keep-warm candidates: sessions whose transcript changed recently, with the plan derived the
 * last time their stored facts were read. Cron maintenance notes changes here synchronously;
 * the keep-warm pass (`prompt-cache-keep-warm.ts`, loaded lazily) reads and pings.
 */

/** Longer lifetimes already cover ordinary breaks; a read does not restart a 12h clock. */
export const MAX_WARM_TTL_MS = 60 * 60_000;
const MIN_WARM_TTL_MS = 5 * 60_000;

export type PromptCacheKeepWarmCandidate = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  dueAtMs: number;
};

export const promptCacheKeepWarmState = resolveGlobalSingleton(
  Symbol.for("openclaw.promptCacheKeepWarm"),
  () => ({
    candidates: new Map<string, PromptCacheKeepWarmCandidate>(),
    providerBackoffUntil: new Map<string, number>(),
    recovered: false,
  }),
);

/** Ping k is due one lead before the lifetime its previous request started ends. */
export function resolvePromptCacheKeepWarmLeadMs(ttlMs: number): number {
  return Math.min(120_000, Math.max(60_000, ttlMs / 10));
}

export function promptCacheKeepWarmCandidateKey(agentId: string, sessionKey: string): string {
  return `${agentId}\u0000${sessionKey}`;
}

/** Machine-paced and internal sessions have no one coming back to a warm cache. */
export function isPromptCacheKeepWarmSessionKey(sessionKey: string): boolean {
  return !(
    isCronRunSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isInternalSessionEffectsKey(sessionKey)
  );
}

/**
 * A transcript change means a new request on the session: its plan re-anchors. The first ping
 * of any tier is at least a short lifetime away, so the read waits until then. Returns the
 * candidate's wake time.
 */
export function notePromptCacheKeepWarmChange(
  change: SessionRowChange,
  now: number,
): number | undefined {
  if ("all" in change || change.scope !== "transcript" || !change.storePath) {
    return undefined;
  }
  const { sessionKey, storePath } = change;
  if (!isPromptCacheKeepWarmSessionKey(sessionKey)) {
    return undefined;
  }
  const agentId = change.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const key = promptCacheKeepWarmCandidateKey(agentId, sessionKey);
  const dueAtMs = now + MIN_WARM_TTL_MS - resolvePromptCacheKeepWarmLeadMs(MAX_WARM_TTL_MS);
  promptCacheKeepWarmState.candidates.set(key, { agentId, sessionKey, storePath, dueAtMs });
  return dueAtMs;
}

/** Earliest candidate wake, or Infinity. */
export function nextPromptCacheKeepWarmDueAtMs(): number {
  let next = Infinity;
  for (const candidate of promptCacheKeepWarmState.candidates.values()) {
    next = Math.min(next, candidate.dueAtMs);
  }
  return next;
}
