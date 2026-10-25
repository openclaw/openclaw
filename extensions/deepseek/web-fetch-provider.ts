import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDeepSeekWebSearchProvider } from "./web-search-provider.js";

const loadRuntime = createLazyRuntimeModule(() => import("./web-fetch-provider.runtime.js"));

export function createDeepSeekWebFetchProvider(): WebFetchProviderPlugin {
  return {
    // Search and Fetch use the same prepared credential and selection-time plugin enabling.
    ...createDeepSeekWebSearchProvider(),
    hint: "Fetch pages with DeepSeek's standalone Fetch API (explicit selection required)",
    docsUrl: "https://docs.openclaw.ai/providers/deepseek#web-fetch",
    createTool: (ctx) => {
      // Inference/search credentials alone must not opt users into paid URL delegation.
      if (
        normalizeOptionalLowercaseString(ctx.config?.tools?.web?.fetch?.provider) !== "deepseek"
      ) {
        return null;
      }
      return {
        description: "Fetch a public page as Markdown or text using DeepSeek.",
        parameters: {},
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const { executeDeepSeekFetch } = await loadRuntime();
          return executeDeepSeekFetch(ctx, args, context?.signal);
        },
      };
    },
  };
}
