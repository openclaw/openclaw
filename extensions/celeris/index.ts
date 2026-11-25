import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export default definePluginEntry({
  id: "celeris",
  name: "Celeris Decision Provider",
  description: "Native typed decisions through Celeris's Decisions API.",
  register(api) {
    api.registerProvider({
      id: "celeris",
      label: "Celeris",
      docsPath: "/providers/celeris",
      envVars: ["CELERIS_API_KEY"],
      // Connecting credentials never changes either model selection.
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "celeris",
          methodId: "api-key",
          label: "Celeris API key",
          optionKey: "celerisApiKey",
          flagName: "--celeris-api-key",
          envVar: "CELERIS_API_KEY",
          promptMessage: "Enter your Celeris API key",
        }),
      ],
    });
    api.registerDecisionProvider({
      id: "celeris",
      contractVersion: 2,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        const { evaluateCelerisDecision } = await loadRuntime();
        context.signal.throwIfAborted();
        return evaluateCelerisDecision(batch, context);
      },
    });
  },
});
