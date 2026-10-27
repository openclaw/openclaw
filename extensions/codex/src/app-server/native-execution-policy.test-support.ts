import { onTestFinished } from "vitest";
import { prepareCodexNativeExecutionPolicyForRun } from "./native-execution-policy.js";

/** Keep the real selected policy alive until the fixture finishes using it. */
export async function prepareTestNativeExecutionPolicy(
  ...args: Parameters<typeof prepareCodexNativeExecutionPolicyForRun>
) {
  const prepared = await prepareCodexNativeExecutionPolicyForRun(...args);
  onTestFinished(prepared.release);
  return prepared;
}
