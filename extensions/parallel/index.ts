import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildParallelDecisionProvider } from "./src/decision-provider.js";
import { createParallelFreeWebSearchProvider } from "./src/parallel-free-web-search-provider.js";
import { createParallelWebSearchProvider } from "./src/parallel-web-search-provider.js";

export default definePluginEntry({
  id: "parallel",
  name: "Parallel Plugin",
  description: "Bundled Parallel web search and Decisions plugin",
  register(api) {
    api.registerProvider({
      id: "parallel",
      label: "Parallel",
      docsPath: "/tools/parallel-search#decisions",
      envVars: ["PARALLEL_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "parallel",
          methodId: "api-key",
          label: "Parallel API key",
          optionKey: "parallelApiKey",
          flagName: "--parallel-api-key",
          envVar: "PARALLEL_API_KEY",
          promptMessage: "Enter Parallel API key",
        }),
      ],
    });
    api.registerDecisionProvider(buildParallelDecisionProvider());
    // Free hosted Search MCP (keyless, opt-in) and the paid v1 REST API
    // (requires PARALLEL_API_KEY) are registered as two distinct providers.
    api.registerWebSearchProvider(createParallelFreeWebSearchProvider());
    api.registerWebSearchProvider(createParallelWebSearchProvider());
  },
});
