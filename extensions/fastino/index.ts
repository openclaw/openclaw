import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export default definePluginEntry({
  id: "fastino",
  name: "Fastino GLiDE",
  description: "Native typed GLiDE decisions.",
  register(api) {
    const provider: DecisionProviderV2 = {
      id: "fastino",
      contractVersion: 2,
      provider: {
        label: "Fastino",
        docsPath: "/providers/fastino",
        envVars: ["FASTINO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "fastino",
            methodId: "api-key",
            label: "Fastino API key",
            optionKey: "fastinoApiKey",
            flagName: "--fastino-api-key",
            envVar: "FASTINO_API_KEY",
            promptMessage: "Enter your Fastino API key",
          }),
        ],
      },
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        const { evaluateFastinoDecision } = await loadRuntime();
        context.signal.throwIfAborted();
        return evaluateFastinoDecision(batch, context);
      },
    };
    api.registerDecisionProvider(provider);
  },
});
