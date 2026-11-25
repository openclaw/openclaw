import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildOpenAIDecisionProvider(): DecisionProviderV2 {
  return {
    id: "openai",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateOpenAIDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateOpenAIDecision(batch, context);
    },
  };
}
