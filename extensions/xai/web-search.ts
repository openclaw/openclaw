import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildXaiWebSearchProviderBase } from "./web-search-provider-shared.js";

const loadXaiWebSearchProviderRuntime = createLazyRuntimeModule(
  () => import("./src/web-search-provider.runtime.js"),
);

const GenericXaiSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildXaiWebSearchProviderBase(),
    runSetup: async (ctx) =>
      (await loadXaiWebSearchProviderRuntime()).runXaiSearchProviderSetup(ctx),
    createTool: (ctx) => ({
      description:
        "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
      parameters: GenericXaiSearchSchema,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        const { executeXaiWebSearchProviderTool } = await loadXaiWebSearchProviderRuntime();
        return await executeXaiWebSearchProviderTool(ctx, args, executionContext);
      },
    }),
  };
}
