const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

/**
 * Cache entry shape captured at write/plan completion. The `fingerprint` is
 * a SHA-256 hex digest of the canonical input shape (config + auth-profiles
 * stable hash + plugin metadata) — NOT the raw stable-stringified payload.
 * Hashing it before storage keeps raw secrets out of process memory
 * (Aisle medium #5 on PR #72869) so heap snapshots / debug telemetry / core
 * dumps cannot leak `apiKey` material via the readyCache.
 *
 * `modelsJsonHash` is captured immediately after the plan-and-write
 * completes successfully. The cache check verifies that the current
 * on-disk models.json still hashes to this value before treating the
 * entry as a hit (Codex P1 on PR #72869). Any external edit / partial
 * corruption / manual tamper changes the hash and invalidates the cache.
 */
type ModelsJsonState = {
  writeLocks: Map<string, Promise<void>>;
  readyCache: Map<
    string,
    Promise<{
      fingerprint: string;
      modelsJsonHash: string | null;
      result: { agentDir: string; wrote: boolean };
    }>
  >;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeLocks: new Map<string, Promise<void>>(),
      readyCache: new Map<
        string,
        Promise<{
          fingerprint: string;
          modelsJsonHash: string | null;
          result: { agentDir: string; wrote: boolean };
        }>
      >(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();

export function resetModelsJsonReadyCacheForTest(): void {
  MODELS_JSON_STATE.writeLocks.clear();
  MODELS_JSON_STATE.readyCache.clear();
}
