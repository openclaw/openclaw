import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildOpenAIDecisionProvider(getConfig: () => OpenClawConfig): DecisionProviderV1 {
  return {
    id: "openai",
    contractVersion: 1,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateOpenAIDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateOpenAIDecision(batch, context, getConfig());
    },
  };
}
