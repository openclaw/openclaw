import { parseStrictPositiveInteger } from "../../../infra/parse-finite-number.js";

type AbortSettleTimeoutEnv = Partial<
  Pick<NodeJS.ProcessEnv, "OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS" | "OPENCLAW_TEST_FAST">
>;

/**
 * Resolves how long cleanup waits for an aborted attempt to settle background
 * work before flushing pending tool results and releasing the session lock.
 *
 * The override intentionally accepts only strict positive decimal integers so
 * operator typos fall back to the known cleanup budget instead of producing
 * surprising timer coercions.
 */
export function resolveEmbeddedAbortSettleTimeoutMs(
  env: AbortSettleTimeoutEnv = process.env,
): number {
  const override = parseStrictPositiveInteger(env.OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS);
  if (override !== undefined) {
    return override;
  }
  return env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;
}
