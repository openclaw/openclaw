import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildClawRouterDecisionProvider(): DecisionProviderV2 {
  return {
    id: "clawrouter",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateClawRouterDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateClawRouterDecision(batch, context);
    },
  };
}
