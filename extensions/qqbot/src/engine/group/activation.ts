/**
 * Group activation mode — how the bot decides whether to respond in a group.
 *
 * Resolution chain:
 *   1. session row override (`/activation` command writes per-session
 *      `groupActivation` value) — highest priority
 *   2. per-group `requireMention` config
 *   3. `"mention"` default (require @-bot to respond)
 *
 * Session-row I/O is isolated in the default node-based reader so the gating
 * logic itself stays a pure function, testable without touching storage.
 *
 * Note: the implicit-mention predicate (quoting a bot message counts as
 * @-ing the bot) lives in `./mention.ts` alongside the other mention
 * helpers — see `resolveImplicitMention` there.
 */

import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

export type GroupActivationMode = "mention" | "always";

/**
 * Pluggable reader that returns parsed session row contents.
 *
 * A return value of `null` means "no override available" (file missing,
 * parse error, or reader disabled). Implementations must **not** throw —
 * the gating pipeline treats any failure as "fall back to the config
 * default".
 */
export interface SessionStoreReader {
  read(params: {
    cfg: Record<string, unknown>;
    agentId: string;
    sessionKey: string;
  }): Record<string, { groupActivation?: string }> | null;
}

export function resolveGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
  sessionStoreReader?: SessionStoreReader;
}): GroupActivationMode {
  const fallback: GroupActivationMode = params.configRequireMention ? "mention" : "always";

  const store = params.sessionStoreReader?.read({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!store) {
    return fallback;
  }

  const entry = store[params.sessionKey];
  if (!entry?.groupActivation) {
    return fallback;
  }

  const normalized = entry.groupActivation.trim().toLowerCase();
  if (normalized === "mention" || normalized === "always") {
    return normalized;
  }
  return fallback;
}

// ────────────────────────── Default node reader ──────────────────────────

/**
 * Create the default, production-ready session-store reader.
 *
 * Reads the current session row synchronously on every call. The overhead is
 * acceptable because activation mode is only resolved once per group message.
 *
 * Any SQLite or row-shape error is swallowed and returned as `null` so the
 * gating pipeline falls back to the config default.
 */
export function createNodeSessionStoreReader(): SessionStoreReader {
  return {
    read: ({ agentId, sessionKey }) => {
      try {
        const entry = getSessionEntry({ agentId: agentId || "default", sessionKey });
        if (!entry?.groupActivation) {
          return null;
        }
        return { [sessionKey]: { groupActivation: entry.groupActivation } };
      } catch {
        return null;
      }
    },
  };
}
