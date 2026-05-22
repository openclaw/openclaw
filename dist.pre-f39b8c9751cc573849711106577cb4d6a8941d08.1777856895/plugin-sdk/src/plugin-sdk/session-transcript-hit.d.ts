import type { SessionEntry } from "../config/sessions/types.js";
export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 */
export declare function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null;
/**
 * Map transcript stem to canonical session store keys (all agents in the combined store).
 * Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
 * `createSessionVisibilityGuard`), including cross-agent cases.
 */
export declare function resolveTranscriptStemToSessionKeys(params: {
    store: Record<string, SessionEntry>;
    stem: string;
}): string[];
