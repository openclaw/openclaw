import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";

export const MCP_CATALOG_LIST_LIMITS = {
  maxPages: 128,
  maxItems: 16_384,
  maxBytes: 10 * 1024 * 1024,
} as const;

export async function listAllMcpTools(
  client: Client,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Tool[]> {
  return await collectMcpPaginatedItems({
    label: "MCP tool listing",
    itemLabel: "tools",
    timeoutMs,
    ...MCP_CATALOG_LIST_LIMITS,
    signal,
    loadPage: async ({ cursor, requestTimeoutMs, signal: requestSignal }) => {
      const requestController = new AbortController();
      const onAbort = () => requestController.abort(requestSignal.reason);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) {
        onAbort();
      }
      try {
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
          ListToolsResultSchema,
          {
            timeout: requestTimeoutMs,
            maxTotalTimeout: requestTimeoutMs,
            signal: requestController.signal,
          },
        );
        return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
      } finally {
        requestSignal.removeEventListener("abort", onAbort);
      }
    },
  });
}
