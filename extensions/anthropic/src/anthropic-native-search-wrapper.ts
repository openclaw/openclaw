import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { buildAnthropicWebSearchServerTool } from "./anthropic-web-search-provider.js";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";

/**
 * Stream wrapper that injects Anthropic's native web_search server tool
 * into the API payload for anthropic-messages models.
 *
 * This is the core mechanism: instead of OpenClaw intercepting tool calls
 * and routing them to an external search API, we add the server tool to
 * the tools array in the Anthropic Messages API request and let Claude
 * handle search execution server-side.
 *
 * Server tool results come back as `server_tool_use` content blocks in
 * the assistant message, with `web_search_tool_result` blocks containing
 * the search results and encrypted content.
 */
export function createAnthropicNativeSearchStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  searchConfig?: SearchConfigRecord,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const serverTool = buildAnthropicWebSearchServerTool(searchConfig);

  return (model, context, options) => {
    // Only apply to anthropic-messages API
    if (model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const tools = Array.isArray(payloadObj.tools) ? payloadObj.tools : [];

          // Check if a web_search server tool is already present
          const hasServerSearch = tools.some(
            (t: unknown) =>
              t &&
              typeof t === "object" &&
              typeof (t as Record<string, unknown>).type === "string" &&
              ((t as Record<string, unknown>).type as string).startsWith("web_search_"),
          );

          if (!hasServerSearch) {
            // Inject the server tool
            payloadObj.tools = [...tools, serverTool];
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
