import { runAgentHarnessAttemptWithFallback } from "../../harness/selection.js";
export async function runEmbeddedAttemptWithBackend(params) {
    return runAgentHarnessAttemptWithFallback(params);
}
