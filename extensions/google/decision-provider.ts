import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildGoogleDecisionProvider(): DecisionProviderV2 {
  return {
    id: "google",
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateGeminiDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateGeminiDecision(batch, context);
    },
  };
}
