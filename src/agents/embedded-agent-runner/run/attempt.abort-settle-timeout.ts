import { parseStrictPositiveInteger } from "../../../infra/parse-finite-number.js";

export function resolveEmbeddedAbortSettleTimeoutMs(
  env: Pick<
    NodeJS.ProcessEnv,
    "OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS" | "OPENCLAW_TEST_FAST"
  > = process.env,
): number {
  const override = parseStrictPositiveInteger(env.OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS);
  if (override !== undefined) {
    return override;
  }
  return env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;
}
