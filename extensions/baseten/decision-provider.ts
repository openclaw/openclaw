import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildBasetenDecisionProvider(): DecisionProviderV2 {
  return {
    id: "baseten",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateBasetenDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateBasetenDecision(batch, context);
    },
  };
}
