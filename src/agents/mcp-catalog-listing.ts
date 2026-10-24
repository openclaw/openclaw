import type { Client, Prompt, Resource, Tool } from "@modelcontextprotocol/client";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";

const MCP_CATALOG_LIST_LIMITS = {
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
      const page = await client.request(
        { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
        {
          timeout: requestTimeoutMs,
          maxTotalTimeout: requestTimeoutMs,
          signal: requestSignal,
        },
      );
      return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
    },
  });
}

export function listMcpServerItems(
  kind: "prompts" | "resources",
  {
    client,
    timeoutMs,
    signal,
    callerSignal,
    runRequest,
  }: {
    client: Client;
    timeoutMs: number;
    signal: AbortSignal;
    callerSignal?: AbortSignal;
    runRequest: <T>(
      request: (signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => Promise<T>;
  },
) {
  return collectMcpPaginatedItems<Prompt | Resource>({
    label: `MCP ${kind === "resources" ? "resource" : "prompt"} listing`,
    itemLabel: kind,
    timeoutMs,
    ...MCP_CATALOG_LIST_LIMITS,
    signal: callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
    loadPage: ({ cursor, requestTimeoutMs: timeout, signal: pageSignal }) =>
      runRequest(async (requestSignal) => {
        const requestParams = cursor === undefined ? undefined : { cursor };
        const requestOptions = { timeout, maxTotalTimeout: timeout, signal: requestSignal };
        if (kind === "resources") {
          const page = await client.request(
            { method: "resources/list", params: requestParams },
            requestOptions,
          );
          return { items: page.resources, nextCursor: page.nextCursor, serializedValue: page };
        }
        const page = await client.request(
          { method: "prompts/list", params: requestParams },
          requestOptions,
        );
        return { items: page.prompts, nextCursor: page.nextCursor, serializedValue: page };
      }, pageSignal),
  });
}

// Tool materialization awaits catalog listing. Bound it for servers without an
// explicit request timeout, with room for a cold remote (OAuth, HTTP) listing.
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 10_000;

export function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  const record = asOptionalObjectRecord(rawServer);
  const configured = ["requestTimeoutMs", "timeout"].some(
    (key) => asPositiveFiniteNumber(record?.[key]) !== undefined,
  );
  return configured ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;
}
