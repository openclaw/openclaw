import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { SageImageProbe } from "./sage-validation.js";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export default definePluginEntry({
  id: "levanto",
  name: "Levanto Sage",
  description: "Native typed decisions with explicit abstention.",
  register(api) {
    const probeImage: SageImageProbe = (bytes) => api.runtime.media.getImageMetadata(bytes);
    api.registerDecisionProvider({
      id: "levanto",
      contractVersion: 2,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        if (
          context.model.provider !== "levanto" ||
          context.model.id !== "levanto-sage" ||
          context.model.api !== undefined
        ) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (!context.auth.apiKey) {
          // Effective headers never provide a second credential-discovery route.
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        const { evaluateLevantoDecision } = await loadRuntime();
        context.signal.throwIfAborted();
        return evaluateLevantoDecision(batch, context, probeImage);
      },
      provider: {
        label: "Levanto Sage",
        docsPath: "/providers/levanto",
        authScope: "agent",
        envVars: ["LEVANTO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "levanto",
            methodId: "api-key",
            label: "Levanto API key",
            optionKey: "levantoApiKey",
            flagName: "--levanto-api-key",
            envVar: "LEVANTO_API_KEY",
            promptMessage: "Enter your Levanto API key",
            // Connecting credentials never changes a conversational or decision model selection.
            wizard: {
              choiceId: "levanto-api-key",
              choiceLabel: "Levanto API key",
              groupId: "levanto",
              groupLabel: "Levanto Sage",
              modelTarget: "utility",
            },
          }),
        ],
      },
    });
  },
});
