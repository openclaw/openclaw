import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";

const RUN_ATTEMPT_NOT_IMPLEMENTED = "[copilot-sdk] runAttempt not implemented; scaffold only";

export interface CreateCopilotSdkAgentHarnessOptions {
  pluginConfig?: unknown;
}

export function createCopilotSdkAgentHarness(
  _options?: CreateCopilotSdkAgentHarnessOptions,
): AgentHarness {
  return {
    id: "copilot-sdk",
    label: "GitHub Copilot SDK",
    supports() {
      return {
        supported: false,
        reason: "copilot-sdk scaffold is not implemented yet",
      };
    },
    async runAttempt() {
      throw new Error(RUN_ATTEMPT_NOT_IMPLEMENTED);
    },
  };
}
