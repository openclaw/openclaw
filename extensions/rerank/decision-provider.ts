import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { RERANK_PROVIDER_ID } from "./decision-metadata.js";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildRerankDecisionProvider(): DecisionProviderV2 {
  return {
    id: RERANK_PROVIDER_ID,
    contractVersion: 2,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluateRerankDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateRerankDecision(batch, context);
    },
  };
}
