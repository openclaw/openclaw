import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createParallelFreeWebSearchProviderBase } from "./parallel-free-web-search-provider.shared.js";
// Reuse the paid provider's tool schema — both transports accept the same
// objective + search_queries shape; only the description/runtime differ.
import { ParallelSearchSchema } from "./parallel-web-search-provider.js";

type ParallelFreeWebSearchRuntime = typeof import("./parallel-free-web-search-provider.runtime.js");

let parallelFreeWebSearchRuntimePromise: Promise<ParallelFreeWebSearchRuntime> | undefined;

function loadParallelFreeWebSearchRuntime(): Promise<ParallelFreeWebSearchRuntime> {
  parallelFreeWebSearchRuntimePromise ??= import("./parallel-free-web-search-provider.runtime.js");
  return parallelFreeWebSearchRuntimePromise;
}

export function createParallelFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelFreeWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Parallel's free Search MCP (no API key). Returns ranked, LLM-optimized dense excerpts from web sources. Pass an `objective` describing the underlying question along with 2-3 short keyword `search_queries` (Parallel's recommended pairing). For multi-step research, thread the prior result's `sessionId` back in as `session_id` to keep Parallel's context grouped.",
      parameters: ParallelSearchSchema,
      execute: async (args, context) => {
        const { executeParallelFreeWebSearchProviderTool } =
          await loadParallelFreeWebSearchRuntime();
        return await executeParallelFreeWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
