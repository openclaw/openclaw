import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export function buildPerplexityDecisionProvider(): DecisionProviderV2 {
  return {
    id: "perplexity-decisions",
    contractVersion: 2,
    provider: {
      label: "Perplexity",
      docsPath: "/providers/perplexity-provider#decision-models",
      envVars: ["PERPLEXITY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "perplexity-decisions",
          methodId: "api-key",
          label: "Perplexity API key",
          optionKey: "perplexityApiKey",
          flagName: "--perplexity-api-key",
          envVar: "PERPLEXITY_API_KEY",
          promptMessage: "Enter your Perplexity API key",
        }),
      ],
    },
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const { evaluatePerplexityDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluatePerplexityDecision(batch, context);
    },
  };
}
