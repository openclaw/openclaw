import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";

const DEFAULT_PROVIDER_IDS = new Set(["cursor-sdk"]);

export function createCursorSdkAgentHarness(options?: { pluginConfig?: unknown }): AgentHarness {
  return {
    id: "cursor-sdk",
    label: "Cursor SDK agent harness",
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (DEFAULT_PROVIDER_IDS.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not cursor-sdk`,
      };
    },
    runAttempt: async (params) => {
      const { runCursorSdkAttempt } = await import("./src/run-attempt.js");
      return runCursorSdkAttempt(params, { pluginConfig: options?.pluginConfig });
    },
    dispose: async () => {},
  };
}
