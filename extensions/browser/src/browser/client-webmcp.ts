import type { BrowserWebMcpRequest } from "./chrome-mcp.webmcp.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";

export async function browserWebMcp(
  baseUrl: string | undefined,
  action: "list" | "execute",
  request: BrowserWebMcpRequest,
  options: { profile?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  return await fetchBrowserJson(
    withBaseUrl(baseUrl, `/webmcp/${action}${buildProfileQuery(options.profile)}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );
}
