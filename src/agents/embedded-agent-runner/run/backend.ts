import { runAgentHarnessAttempt } from "../../harness/selection.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Runs the selected agent harness backend while preserving the embedded-run result contract. */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  return runAgentHarnessAttempt(params);
}
