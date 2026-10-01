import { z } from "zod";
import type { ChromeMcpTargetOperation, ChromeMcpToolResult } from "./chrome-mcp-contracts.js";
import { extractJsonMessage, extractSnapshot } from "./chrome-mcp-result.js";
import { callTool, withChromeMcpTarget } from "./chrome-mcp-routing.js";

const MAX_BYTES = 64 * 1024;
const toolSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(8192),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export type BrowserWebMcpTool = z.infer<typeof toolSchema>;
export type BrowserWebMcpRequest = {
  targetId: string;
  contextId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
};

/** Bound page-controlled JSON before traversing or returning it. Never trim a schema. */
function boundedJson(value: unknown): string {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 8192 || entry.depth > 16) {
      throw new Error("WebMCP JSON exceeds the supported size or depth (16).");
    }
    if (entry.value && typeof entry.value === "object") {
      for (const child of Object.values(entry.value)) {
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_BYTES) {
    throw new Error("WebMCP JSON exceeds the 64 KiB limit.");
  }
  return json;
}

/** Discover or invoke through the existing session lock and explicit page routing. */
export async function runChromeMcpWebMcp(
  params: ChromeMcpTargetOperation & BrowserWebMcpRequest,
  execute: boolean,
): Promise<{ contextId: string; tools?: BrowserWebMcpTool[]; result?: unknown }> {
  if (execute && (!params.contextId || !params.toolName?.trim())) {
    throw new Error("webmcp_execute requires contextId from webmcp_list and toolName.");
  }
  if (
    params.input !== undefined &&
    (!params.input || typeof params.input !== "object" || Array.isArray(params.input))
  ) {
    throw new Error("WebMCP input must be a JSON object.");
  }
  const input = boundedJson(params.input ?? {});
  return await withChromeMcpTarget(params, async (target) => {
    const advertised = await target.lease.session.client.listTools(undefined, {
      signal: params.signal,
      timeout: params.timeoutMs,
    });
    for (const name of ["list_webmcp_tools", "execute_webmcp_tool"]) {
      const tool = advertised.tools.find((entry) => entry.name === name);
      if (!tool || !tool.inputSchema.properties?.pageId) {
        throw new Error(
          "WebMCP is unavailable. Use Chrome MCP with page routing and --categoryExperimentalWebmcp=true on an existing-session profile.",
        );
      }
    }
    const call = (name: string, args: Record<string, unknown> = {}): Promise<ChromeMcpToolResult> =>
      callTool(
        params.profileName,
        target.profileOptions,
        name,
        { ...args, pageId: target.pageId },
        params,
        target.lease,
      );
    const documentId = async () => {
      const snapshot = extractSnapshot(await call("take_snapshot"));
      if (!snapshot.id || snapshot.role?.toLowerCase() !== "rootwebarea") {
        throw new Error("WebMCP document unavailable. List tools again after the page loads.");
      }
      return `${params.targetId}/${snapshot.id}`;
    };
    const contextId = await documentId();
    if (execute && contextId !== params.contextId) {
      throw new Error("WebMCP stale context. The page or session changed; run webmcp_list again.");
    }
    const discovered = (await call("list_webmcp_tools")).structuredContent?.webmcpTools;
    boundedJson(discovered);
    const tools = z.array(toolSchema).max(64).parse(discovered);
    if (execute && !tools.some((tool) => tool.name === params.toolName)) {
      throw new Error(
        "WebMCP tool not found in the current document. List tools again; check Chrome WebMCP enablement if the list is empty.",
      );
    }
    if ((await documentId()) !== contextId) {
      throw new Error(
        "WebMCP stale context. The document changed during discovery; list tools again.",
      );
    }
    if (!execute) {
      return { contextId, tools };
    }
    // MCP has no atomic expected-document argument. Detect replacement after dispatch,
    // but never retry a mutation whose outcome may already have taken effect.
    try {
      const response = await call("execute_webmcp_tool", { toolName: params.toolName, input });
      if ((await documentId()) !== contextId) {
        throw new Error("document replaced");
      }
      const result = extractJsonMessage(response);
      boundedJson(result);
      return { contextId, result };
    } catch (cause) {
      throw new Error("WebMCP execution outcome unknown. Inspect the page before retrying.", {
        cause,
      });
    }
  });
}
