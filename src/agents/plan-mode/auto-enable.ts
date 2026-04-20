/**
 * C3 (Plan Mode 1.0 follow-up): auto-enable matching.
 *
 * Evaluates whether a given model id matches any of the regex
 * patterns configured under `agents.defaults.planMode.autoEnableFor`.
 * When a match is found, the runtime caller is expected to flip the
 * session into plan mode at session start (unless the user has
 * already toggled it explicitly).
 *
 * This helper is intentionally pure and synchronous so it can be
 * called from hot paths (session-entry materialization, cron-turn
 * setup) without adding async overhead.
 *
 * Compiled-regex cache: patterns rarely change at runtime (config is
 * static within a gateway lifetime); compiling each pattern once and
 * memoizing avoids per-call regex allocation. The cache key is the
 * raw pattern string so callers don't need to pre-compile.
 */

const compiledPatternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  if (compiledPatternCache.has(pattern)) {
    return compiledPatternCache.get(pattern) ?? null;
  }
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    // Malformed pattern → treat as non-matching. Operators see the
    // set-value go silent rather than a gateway crash; the intent is
    // "auto-enable for these models", and a broken pattern should
    // not enable for EVERY model.
    compiled = null;
  }
  compiledPatternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Returns true when `modelId` matches any of the supplied regex
 * patterns. Empty / undefined inputs return false (no match, do not
 * auto-enable).
 *
 * @param modelId — session's resolved model id, e.g. `openai/gpt-5.4`
 * @param patterns — array of regex pattern strings from the config
 *   under `agents.defaults.planMode.autoEnableFor`
 */
export function evaluateAutoEnableForMatch(
  modelId: string | undefined,
  patterns: ReadonlyArray<string> | undefined,
): boolean {
  if (!modelId || typeof modelId !== "string" || modelId.length === 0) {
    return false;
  }
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    const compiled = compilePattern(raw);
    if (compiled && compiled.test(modelId)) {
      return true;
    }
  }
  return false;
}

/**
 * Test-only: clear the compiled-pattern cache. Production code should
 * never call this; tests that exercise malformed-pattern behavior use
 * it to keep cases independent.
 */
export function __resetCompiledPatternCacheForTests(): void {
  compiledPatternCache.clear();
}
