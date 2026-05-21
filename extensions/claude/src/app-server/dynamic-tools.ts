/**
 * Projects OpenClaw's tool registry into the `DynamicToolSpec[]` shape the
 * codex-shaped server consumes, and dispatches `item/tool/call` requests
 * back to the underlying `AnyAgentTool` instances.
 *
 * This is the seam that makes "OpenClaw tools callable from inside a Claude
 * turn" actually work — the protocol pieces are all in the server; this
 * module is the bridge between OpenClaw's tool registry and the server's
 * dynamic-tool surface.
 *
 * Minimum-viable v1: we read each tool's name/description/schema, ship them
 * as-is, and execute on call. Codex's `dynamic-tools.ts` does considerably
 * more (middleware, telemetry, messaging-tool tracking, heartbeat handling);
 * future revisions can layer those on.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonValue,
} from "./types.js";

export type ClaudeDynamicToolBridge = {
  specs: DynamicToolSpec[];
  handleToolCall: (
    params: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ) => Promise<DynamicToolCallResponse>;
};

export function createClaudeDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  signal?: AbortSignal;
  excludeNames?: Iterable<string>;
}): ClaudeDynamicToolBridge {
  const excluded = new Set([...(params.excludeNames ?? [])].map((n) => n.trim()).filter(Boolean));
  const toolsByName = new Map<string, AnyAgentTool>();
  const specs: DynamicToolSpec[] = [];
  for (const tool of params.tools) {
    if (!tool?.name || excluded.has(tool.name)) continue;
    toolsByName.set(tool.name, tool);
    specs.push({
      name: tool.name,
      description: tool.description ?? "",
      // TypeBox schemas are JSON-Schema-shaped; ship verbatim.
      inputSchema: (tool.parameters ?? { type: "object", additionalProperties: true }) as JsonValue,
    });
  }

  async function handleToolCall(
    call: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ): Promise<DynamicToolCallResponse> {
    const tool = toolsByName.get(call.tool);
    if (!tool) {
      return errorResponse(`Unknown openclaw tool: ${call.tool}`);
    }
    try {
      const callerSignal = options?.signal ?? params.signal;
      const args = (call.arguments ?? {}) as unknown;
      const result = await tool.execute(call.callId, args, callerSignal);
      return projectAgentToolResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(`Tool execution failed: ${msg}`);
    }
  }

  return { specs, handleToolCall };
}

function projectAgentToolResult(result: unknown): DynamicToolCallResponse {
  // AgentToolResult is opaque from the SDK seam we use — shape varies per
  // tool. Codex's full bridge sniffs media/content blocks; for v1 we project
  // text + the boolean isError flag, falling back to JSON.stringify for
  // structured results.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const isError = obj.isError === true || obj.is_error === true;
    const contentItems = extractContentItems(obj);
    return {
      contentItems:
        contentItems.length > 0
          ? contentItems
          : [{ type: "inputText", text: stringifyResult(obj) }],
      success: !isError,
    };
  }
  return {
    contentItems: [{ type: "inputText", text: String(result) }],
    success: true,
  };
}

function extractContentItems(result: Record<string, unknown>): DynamicToolCallOutputContentItem[] {
  const items: DynamicToolCallOutputContentItem[] = [];

  // Common AgentToolResult shapes:
  //  - { content: string }
  //  - { content: Array<{type, text|imageUrl|...}> }
  //  - { text: string }
  //  - { result: any, ... }
  const content = result.content;
  if (typeof content === "string") {
    items.push({ type: "inputText", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        items.push({ type: "inputText", text: b.text });
      } else if (b.type === "image_url" && typeof b.image_url === "string") {
        items.push({ type: "inputImage", imageUrl: b.image_url });
      } else if (b.type === "image" && typeof b.url === "string") {
        items.push({ type: "inputImage", imageUrl: b.url as string });
      }
    }
  }
  if (items.length === 0 && typeof result.text === "string") {
    items.push({ type: "inputText", text: result.text });
  }
  return items;
}

function stringifyResult(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function errorResponse(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
}
