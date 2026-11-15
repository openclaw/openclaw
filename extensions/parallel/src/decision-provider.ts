import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildParallelDecisionProvider(): DecisionProviderV2 {
  return {
    id: "parallel",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateParallelDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateParallelDecision(batch, context);
    },
  };
}
