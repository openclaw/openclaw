// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

/**
 * Outcome of a safe content read of a sensitive config file
 * (`auth-profiles.json` / `models.json`).  This is a discriminated
 * union — NOT `string | null` — so callers can distinguish three
 * fundamentally different states that all used to collapse to `null`:
 *
 *  - `absent`: the file legitimately does not exist.  Two consecutive
 *    `absent` reads compare equal, which is a valid steady-state cache
 *    hit (the file was never written and still isn't).
 *  - `hashed`: a content hash was computed successfully.  Two `hashed`
 *    outcomes compare equal iff their hashes match.
 *  - `uncacheable`: the file exists but the read failed validation
 *    (oversize, symlink, non-regular, or any other I/O error).  This
 *    NEVER compares equal to anything — even to another `uncacheable`
 *    — so the readyCache cannot grant a hit while the file is in this
 *    state.  See the threat model in `safeReadFileOutcome` JSDoc on
 *    `models-config.ts` (Codex P1+P2 follow-up on PR #73260).
 */
export type ContentHashOutcome =
  | { kind: "absent" }
  | { kind: "hashed"; hash: string }
  | { kind: "uncacheable" };

/**
 * Cache entry shape captured at write/plan completion. The `fingerprint` is
 * a SHA-256 hex digest of the canonical input shape (config + auth-profiles
 * stable hash + plugin metadata) — NOT the raw stable-stringified payload.
 * Hashing it before storage keeps raw secrets out of process memory
 * (Aisle medium #5 on PR #72869) so heap snapshots / debug telemetry / core
 * dumps cannot leak `apiKey` material via the readyCache.
 *
 * `modelsJsonOutcome` is captured immediately after the plan-and-write
 * completes successfully. The cache check verifies that the current
 * on-disk models.json still produces a matching outcome before treating
 * the entry as a hit (Codex P1 on PR #72869, hardened in Codex P1
 * follow-up on PR #73260: `uncacheable` outcomes never match, so
 * unhashable models.json — oversize, symlinked, I/O error — fail closed
 * to a re-plan instead of treating null-equality as a stable hit).
 *
 * `pluginCatalogsOutcome` does the same for the generated plugin model
 * catalog sidecars (`plugins/<plugin>/catalog.json`) that the planner owns
 * and `ModelRegistry` later consumes. It is validated on every warm hit
 * alongside `modelsJsonOutcome`, so a sidecar deleted/tampered after the
 * entry was cached forces a re-plan instead of riding a stale hit (Codex P1
 * on PR #90741). Same fail-closed contract: an `uncacheable` sidecar outcome
 * never compares equal.
 */
type ModelsJsonReadyCacheEntry = {
  fingerprint: string;
  modelsJsonOutcome: ContentHashOutcome;
  pluginCatalogsOutcome: ContentHashOutcome;
  result: { agentDir: string; wrote: boolean };
};

type ModelsJsonState = {
  writeLocks: Map<string, Promise<void>>;
  readyCache: Map<string, Promise<ModelsJsonReadyCacheEntry>>;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeLocks: new Map<string, Promise<void>>(),
      readyCache: new Map<string, Promise<ModelsJsonReadyCacheEntry>>(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();

/** Clear models.json write/ready caches for tests. */
export function resetModelsJsonReadyCacheForTest(): void {
  MODELS_JSON_STATE.writeLocks.clear();
  MODELS_JSON_STATE.readyCache.clear();
}
