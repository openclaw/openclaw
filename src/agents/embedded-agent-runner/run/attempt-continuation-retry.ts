import { prepareAgentProviderRetryCount } from "../../agent-project-settings-prepared.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type RetrySettingsInput = Parameters<typeof prepareAgentProviderRetryCount>[0];

/** Capture one native owner's admitted local settings before execution, then project once. */
export function createAttemptContinuationRetryCount(
  params: { config?: RetrySettingsInput["cfg"] },
  runtime: Pick<RetrySettingsInput, "pluginMetadataSnapshot"> & {
    pluginHarnessOwnsTransport: boolean;
  },
  scope: Pick<RetrySettingsInput, "sessionId" | "agentDir">,
  assertActive: () => void,
) {
  let providerRetryMaxRetries: number | undefined;
  let preparedCwd: string | undefined;
  const prepareContinuationRetryCount = ({ cwd }: { cwd: string }) => {
    assertActive();
    if (preparedCwd !== undefined) {
      if (preparedCwd !== cwd) {
        throw new Error("Native execution cwd changed after continuation retry preparation");
      }
      return;
    }
    // Freeze absence too: in-turn settings edits cannot change this attempt's budget.
    providerRetryMaxRetries = prepareAgentProviderRetryCount({
      ...scope,
      cwd,
      cfg: params.config,
      pluginMetadataSnapshot: runtime.pluginMetadataSnapshot,
    });
    preparedCwd = cwd;
  };
  return {
    capability: runtime.pluginHarnessOwnsTransport ? { prepareContinuationRetryCount } : {},
    applyTo: (attempt: EmbeddedRunAttemptResult) => {
      // Explicit host count wins; omitted count and native delay/timeout remain harness-owned.
      if (providerRetryMaxRetries !== undefined) {
        attempt.providerRetryMaxRetries = providerRetryMaxRetries;
      }
    },
  };
}
