import type { BrowserWebMcpRequest } from "./chrome-mcp.webmcp.js";
import { requestBrowserJson, type BrowserClientTarget } from "./client-request.js";
import { withWebMcpOutcome } from "./webmcp-outcome.js";

export async function browserWebMcp(
  target: BrowserClientTarget,
  action: "list" | "execute",
  request: BrowserWebMcpRequest,
  options: { profile?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  return await withWebMcpOutcome(action, () =>
    requestBrowserJson(target, `/webmcp/${action}`, {
      method: "POST",
      body: request,
      profile: options.profile,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }),
  );
}
