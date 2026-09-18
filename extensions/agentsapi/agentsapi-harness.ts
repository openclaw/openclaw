import {
  abortAndDrainAgentHarnessRun,
  type AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

/** Explicit MVP harness; the existing OpenAI runtime defaults remain unchanged. */
export function createAgentsApiHarness(runtime: PluginRuntime): AgentHarnessV2 {
  let disposed = false;
  const runningSessions = new Set<string>();
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Agents API harness is disposed");
    }
  };
  return {
    id: "agentsapi",
    label: "OpenAI Agents API (MVP)",
    autoSelection: { providerIds: [] },
    deliveryDefaults: { visibleReplies: "automatic" },
    supports: (ctx) => {
      if (ctx.provider !== "openai") {
        return { supported: false, reason: "Agents API requires the OpenAI provider" };
      }
      if (
        ctx.modelProvider?.preparedAuth?.requirement === "subscription" ||
        (ctx.modelProvider?.api && ctx.modelProvider.api !== "openai-responses") ||
        ctx.modelProvider?.requestTransportOverrides === "present" ||
        (ctx.modelProvider?.baseUrl && ctx.modelProvider.baseUrl !== "https://api.openai.com/v1")
      ) {
        return { supported: false, reason: "Agents API MVP requires the official API-key route" };
      }
      return { supported: true };
    },
    runAttempt: async (params) => {
      assertCurrent();
      const { runAgentsApiAttempt } = await import("./agentsapi-attempt.js");
      assertCurrent();
      runningSessions.add(params.sessionId);
      try {
        return await runAgentsApiAttempt(params, runtime, assertCurrent);
      } finally {
        runningSessions.delete(params.sessionId);
      }
    },
    reset: async (params) => {
      if (params.sessionId) {
        const { agentsApiBindingStore } = await import("./agentsapi-attempt.js");
        assertCurrent();
        agentsApiBindingStore(runtime).delete(params.sessionId);
      }
    },
    withSessionDeletion: async (params, run) => {
      const { agentsApiBindingStore } = await import("./agentsapi-attempt.js");
      params.assertCurrent();
      assertCurrent();
      const store = agentsApiBindingStore(runtime);
      const binding = store.lookup(params.sessionId);
      let removed = false;
      return run({
        commit: () => {
          params.assertCurrent();
          assertCurrent();
          if (store.lookup(params.sessionId)?.sessionId !== binding?.sessionId) {
            throw new Error("Agents API binding changed before session deletion");
          }
          removed = store.delete(params.sessionId);
        },
        rollback: () => {
          if (removed && binding) {
            store.registerIfAbsent(params.sessionId, binding);
          }
        },
      });
    },
    dispose: async () => {
      await Promise.all(
        [...runningSessions].map((sessionId) =>
          abortAndDrainAgentHarnessRun({ sessionId, settleMs: 95_000 }),
        ),
      );
      disposed = true;
    },
  };
}
