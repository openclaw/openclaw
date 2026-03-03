/**
 * In-Process MCP Tool Server
 *
 * Creates an MCP server that exposes OpenClaw tools to the Claude Agent SDK's
 * agentic loop. The MCP handler dispatches to existing wrapped .execute() methods,
 * which automatically fire before_tool_call hooks, tool loop detection, and abort
 * signal propagation (applied upstream at pi-tools.ts:492-497).
 *
 * Tool lifecycle events (tool_execution_start/update/end) are emitted here to the
 * subscriber list, NOT from the event-adapter. This keeps tool execution self-contained.
 *
 * Per implementation-plan.md Section 4.3 and 4.7.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { estimateBase64DecodedBytes } from "../../media/base64.js";
import {
  HARD_MAX_TOOL_RESULT_CHARS,
  truncateToolResultText,
} from "../pi-embedded-runner/tool-result-truncation.js";
import { typeboxToZod } from "./schema-adapter.js";
import type { ClaudeSdkMcpToolServerParams } from "./types.js";

// ---------------------------------------------------------------------------
// Tool result formatting for MCP protocol
// ---------------------------------------------------------------------------

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

type ToolPairingFailure = {
  kind: "tool_pairing_error";
  code: "missing_tool_use_id";
  toolName: string;
  message: string;
};

/**
 * Formats an OpenClaw tool result into MCP-protocol format.
 * Handles text, image (mediaUrls), and object results.
 */
function formatToolResultForMcp(result: unknown): McpToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }

  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const items = (
      result as {
        content: Array<{
          type?: string;
          text?: string;
          url?: string;
          data?: string;
          mediaType?: string;
        }>;
      }
    ).content;
    const content: McpContent[] = [];
    for (const item of items) {
      if (item.type === "image" || item.type === "image_url") {
        const data = item.data ?? item.url ?? "";
        const mimeType = item.mediaType ?? "image/png";
        if (data.startsWith("data:")) {
          const parsed = parseDataUri(data);
          content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType ?? mimeType });
        } else {
          content.push({ type: "image", data, mimeType });
        }
      } else {
        content.push({ type: "text", text: item.text ?? stringifyToolResult(item) });
      }
    }
    return { content: content.length > 0 ? content : [{ type: "text", text: "" }] };
  }

  if (result && typeof result === "object") {
    const obj = result as { text?: string; mediaUrls?: string[] };
    if (Array.isArray(obj.mediaUrls) && obj.mediaUrls.length > 0) {
      const content: McpContent[] = [];
      if (obj.text) {
        content.push({ type: "text", text: obj.text });
      }
      for (const url of obj.mediaUrls) {
        if (url.startsWith("data:")) {
          const parsed = parseDataUri(url);
          content.push({
            type: "image",
            data: parsed.data,
            mimeType: parsed.mimeType ?? "image/png",
          });
        } else {
          content.push({ type: "image", data: url, mimeType: "image/png" });
        }
      }
      return { content: content.length > 0 ? content : [{ type: "text", text: obj.text ?? "" }] };
    }
  }

  return { content: [{ type: "text", text: stringifyToolResult(result) }] };
}

function formatToolPairingFailureForMcp(failure: ToolPairingFailure): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
    isError: true,
  };
}

async function invokeToolExecute(params: {
  execute: (...args: unknown[]) => Promise<unknown>;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (update: unknown) => void;
}): Promise<unknown> {
  if (params.execute.length >= 5) {
    return params.execute(
      params.toolCallId,
      params.args,
      params.signal,
      params.onUpdate,
      undefined,
    );
  }
  return params.execute(params.toolCallId, params.args, params.signal, params.onUpdate);
}

function parseDataUri(url: string): { data: string; mimeType?: string } {
  const [header, payload] = url.split(",", 2);
  const mimeType = header.split(":")[1]?.split(";")[0];
  return { data: payload ?? url, mimeType };
}

function stringifyToolResult(result: unknown): string {
  if (result === undefined) {
    return "undefined";
  }
  const json = JSON.stringify(result);
  if (typeof json === "string") {
    return json;
  }
  // json is undefined: result is non-serializable (function, symbol, circular object)
  return typeof result === "symbol" ? result.toString() : `[unserializable ${typeof result}]`;
}

function summarizeToolResultBlockForTranscript(block: McpContent): { type: "text"; text: string } {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  const looksLikeUrl = /^https?:\/\//i.test(block.data);
  if (looksLikeUrl) {
    return {
      type: "text",
      text: `[tool_image_ref type=url mimeType=${block.mimeType} url=${block.data}]`,
    };
  }
  const estimatedBytes = estimateBase64DecodedBytes(block.data);
  return {
    type: "text",
    text: `[tool_image_ref type=inline mimeType=${block.mimeType} estimatedBytes=${estimatedBytes}]`,
  };
}

// ---------------------------------------------------------------------------
// MCP tool server factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-process MCP server from an array of OpenClaw tools.
 * Each tool is registered with its name, description, and Zod-converted schema.
 * The handler calls the tool's wrapped .execute() method (which fires before_tool_call hook).
 */
export function createClaudeSdkMcpToolServer(
  params: ClaudeSdkMcpToolServerParams,
): ReturnType<typeof createSdkMcpServer> {
  const { tools, emitEvent, getAbortSignal } = params;

  const mcpTools = tools.map((openClawTool) => {
    let zodSchema: ReturnType<typeof typeboxToZod>;
    try {
      zodSchema = typeboxToZod(openClawTool.parameters as TSchema);
    } catch {
      zodSchema = {};
    }

    return tool(
      openClawTool.name,
      openClawTool.description ?? "",
      zodSchema,
      async (args: Record<string, unknown>, _extra: unknown) => {
        // Tool call IDs must come from SDK assistant tool_use messages.
        // Do not use handler "extra" metadata or synthetic/by-name fallbacks.
        //
        // FIFO pairing: the SDK invokes MCP tool handlers in the same order that
        // tool_use blocks appear in the assistant message. consumePendingToolUse()
        // shifts the front of the queue populated by rememberPendingToolUses() in
        // event-adapter.ts, so index 0 in the queue matches the first tool called,
        // index 1 matches the second, etc. This invariant holds because the SDK does
        // not parallelize tool execution within a single assistant turn.
        const pendingToolUse = params.consumePendingToolUse();
        if (!pendingToolUse) {
          const fallbackToolCallId = `missing_tool_use_id:${crypto.randomUUID()}`;
          const failure: ToolPairingFailure = {
            kind: "tool_pairing_error",
            code: "missing_tool_use_id",
            toolName: openClawTool.name,
            message: `Missing SDK tool_use id for tool "${openClawTool.name}"`,
          };
          emitEvent({
            type: "tool_execution_start",
            toolName: openClawTool.name,
            toolCallId: fallbackToolCallId,
            args,
          } as never);
          emitEvent({
            type: "tool_execution_end",
            toolCallId: fallbackToolCallId,
            toolName: openClawTool.name,
            result: failure.message,
            isError: true,
          } as never);
          const toolResultMessage = {
            role: "toolResult",
            toolCallId: fallbackToolCallId,
            toolName: openClawTool.name,
            content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
            isError: true,
            timestamp: Date.now(),
          } as AgentMessage;
          params.appendRuntimeMessage?.(toolResultMessage);
          try {
            params.sessionManager?.appendMessage?.(toolResultMessage);
          } catch {}
          return formatToolPairingFailureForMcp(failure);
        }
        const toolCallId = pendingToolUse.id;
        const signal = getAbortSignal();

        emitEvent({
          type: "tool_execution_start",
          toolName: openClawTool.name,
          toolCallId,
          args,
        } as never);

        // Yield once so block-reply handlers can flush before heavy tool execution.
        await new Promise((resolve) => setTimeout(resolve, 0));

        try {
          const result = await invokeToolExecute({
            execute: openClawTool.execute as (...args: unknown[]) => Promise<unknown>,
            toolCallId,
            args,
            signal,
            onUpdate: (update: unknown) => {
              // Override type/tool IDs after spreading update payload to prevent clobbering.
              emitEvent({
                ...(update && typeof update === "object" ? update : {}),
                type: "tool_execution_update",
                toolCallId,
                toolName: openClawTool.name,
              } as never);
            },
          });

          emitEvent({
            type: "tool_execution_end",
            toolCallId,
            toolName: openClawTool.name,
            result,
            isError: false,
          } as never);

          const mcpResult = formatToolResultForMcp(result);

          // Guard against oversized tool results.
          mcpResult.content = mcpResult.content.map((block) => {
            if (block.type === "text") {
              return {
                ...block,
                text: truncateToolResultText(block.text, HARD_MAX_TOOL_RESULT_CHARS),
              };
            }
            return block;
          });

          const toolResultMessage = {
            role: "toolResult",
            toolCallId,
            toolName: openClawTool.name,
            content: mcpResult.content.map((block) => summarizeToolResultBlockForTranscript(block)),
            isError: false,
            timestamp: Date.now(),
          } as AgentMessage;
          params.appendRuntimeMessage?.(toolResultMessage);

          try {
            params.sessionManager?.appendMessage?.(toolResultMessage);
          } catch {}

          return mcpResult;
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);

          emitEvent({
            type: "tool_execution_end",
            toolCallId,
            toolName: openClawTool.name,
            result: errorText,
            isError: true,
          } as never);

          const toolResultMessage = {
            role: "toolResult",
            toolCallId,
            toolName: openClawTool.name,
            content: [{ type: "text", text: errorText }],
            isError: true,
            timestamp: Date.now(),
          } as AgentMessage;
          params.appendRuntimeMessage?.(toolResultMessage);

          try {
            params.sessionManager?.appendMessage?.(toolResultMessage);
          } catch {}

          return {
            content: [{ type: "text" as const, text: errorText }],
            isError: true,
          };
        }
      },
    );
  });

  return createSdkMcpServer({
    name: "openclaw-tools",
    version: "1.0.0",
    tools: mcpTools,
  });
}
