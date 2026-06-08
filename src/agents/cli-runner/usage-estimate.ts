/**
 * Backend-owned token-usage estimator wiring.
 *
 * Text-output CLI backends (e.g. `agy --print`) cannot surface structured
 * usage on stdout. A plugin may supply `estimateUsage` to fill the gap with
 * a heuristic; this helper applies it without coupling the core runner to
 * any tokenizer.
 */
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { CliOutput } from "../cli-output.js";

/** Per-turn context handed to the estimator wiring. */
export type ApplyBackendEstimateUsageContext = {
  promptText: string;
  modelId: string;
};

/**
 * Returns `output` unchanged when usage is already populated or the backend
 * supplies no estimator. Otherwise returns a copy with `usage` set from
 * `backend.estimateUsage`. The estimator may opt out per-turn by returning
 * `undefined`.
 */
export function applyBackendEstimateUsage(
  backend: Pick<CliBackendPlugin, "estimateUsage"> | undefined,
  output: CliOutput,
  ctx: ApplyBackendEstimateUsageContext,
): CliOutput {
  if (output.usage) {
    return output;
  }
  const estimator = backend?.estimateUsage;
  if (!estimator) {
    return output;
  }
  const estimated = estimator({
    promptText: ctx.promptText,
    assistantText: output.text,
    modelId: ctx.modelId,
  });
  if (!estimated) {
    return output;
  }
  return { ...output, usage: estimated };
}
