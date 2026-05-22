/**
 * Projects OpenClaw's tool registry into the `DynamicToolSpec[]` shape the
 * codex-shaped server consumes, and dispatches `item/tool/call` requests
 * back to the underlying `AnyAgentTool` instances.
 *
 * Native hook relay + telemetry are wired through the same plugin-SDK
 * helpers codex uses:
 *   - `wrapToolWithBeforeToolCallHook` fires OpenClaw `BeforeToolCall` hooks
 *     around each tool execution so plugin observers see Claude's calls.
 *   - `runAgentHarnessAfterToolCallHook` fires the `AfterToolCall` hook with
 *     timing + result.
 *   - `extractToolResultMediaArtifact` + `filterToolResultMediaUrls` lift
 *     media URLs and audio-as-voice flags out of tool results into the
 *     telemetry channel the run-attempt copies into AttemptResult.
 *   - `isMessagingTool` + `isMessagingToolSendAction` detect when Claude
 *     called OpenClaw's `message` tool so we can populate
 *     `didSendViaMessagingTool` and the messagingToolSent* fields.
 */

import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  isMessagingTool,
  isMessagingToolSendAction,
  isToolWrappedWithBeforeToolCallHook,
  normalizeHeartbeatToolResponse,
  runAgentHarnessAfterToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
  wrapToolWithBeforeToolCallHook,
  type AnyAgentTool,
  type EmbeddedRunAttemptParams,
  type HeartbeatToolResponse,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonValue,
} from "./types.js";

export type ClaudeDynamicToolHookContext = {
  agentId?: string;
  config?: EmbeddedRunAttemptParams["config"];
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
};

export type ClaudeDynamicToolTelemetry = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls: string[];
  toolAudioAsVoice: boolean;
};

export type ClaudeDynamicToolBridge = {
  specs: DynamicToolSpec[];
  telemetry: ClaudeDynamicToolTelemetry;
  handleToolCall: (
    params: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ) => Promise<DynamicToolCallResponse>;
};

export function createClaudeDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  signal?: AbortSignal;
  excludeNames?: Iterable<string>;
  hookContext?: ClaudeDynamicToolHookContext;
}): ClaudeDynamicToolBridge {
  const excluded = new Set([...(params.excludeNames ?? [])].map((n) => n.trim()).filter(Boolean));
  const hookContext = params.hookContext ?? {};
  // Wrap each tool so OpenClaw `BeforeToolCall` hooks fire around it. The
  // runtime's existing wrapping (if any) is preserved; we only attach when
  // missing.
  const wrappedTools = params.tools
    .filter((tool) => tool?.name && !excluded.has(tool.name))
    .map((tool) => {
      if (isToolWrappedWithBeforeToolCallHook(tool)) {
        setBeforeToolCallDiagnosticsEnabled(tool, false);
        return tool;
      }
      return wrapToolWithBeforeToolCallHook(tool, hookContext, { emitDiagnostics: false });
    });
  const toolsByName = new Map(wrappedTools.map((t) => [t.name, t]));
  const specs: DynamicToolSpec[] = wrappedTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    // TypeBox schemas are JSON-Schema-shaped; ship verbatim.
    inputSchema: (tool.parameters ?? { type: "object", additionalProperties: true }) as JsonValue,
  }));
  const telemetry: ClaudeDynamicToolTelemetry = {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
  };

  async function handleToolCall(
    call: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ): Promise<DynamicToolCallResponse> {
    const tool = toolsByName.get(call.tool);
    if (!tool) {
      return errorResponse(`Unknown openclaw tool: ${call.tool}`);
    }
    const callerSignal = options?.signal ?? params.signal;
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const startedAt = Date.now();
    try {
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const result = await tool.execute(call.callId, preparedArgs, callerSignal);
      const isError = isResultError(result);
      collectTelemetry({ telemetry, toolName: tool.name, args, result, isError });
      void runAgentHarnessAfterToolCallHook({
        toolName: tool.name,
        toolCallId: call.callId,
        runId: hookContext.runId,
        agentId: hookContext.agentId,
        sessionId: hookContext.sessionId,
        sessionKey: hookContext.sessionKey,
        channelId: hookContext.channelId,
        startArgs: args,
        result,
        startedAt,
      });
      return {
        contentItems: projectContentItems(result),
        success: !isError,
      };
    } catch (err) {
      collectTelemetry({ telemetry, toolName: tool.name, args, result: undefined, isError: true });
      const message = err instanceof Error ? err.message : String(err);
      void runAgentHarnessAfterToolCallHook({
        toolName: tool.name,
        toolCallId: call.callId,
        runId: hookContext.runId,
        agentId: hookContext.agentId,
        sessionId: hookContext.sessionId,
        sessionKey: hookContext.sessionKey,
        channelId: hookContext.channelId,
        startArgs: args,
        error: message,
        startedAt,
      });
      return errorResponse(`Tool execution failed: ${message}`);
    }
  }

  return { specs, telemetry, handleToolCall };
}

// ─── Telemetry ──────────────────────────────────────────────────────────────

function collectTelemetry(params: {
  telemetry: ClaudeDynamicToolTelemetry;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}): void {
  if (!params.isError && params.toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const response = normalizeHeartbeatToolResponse(
      (params.result as { details?: unknown } | undefined)?.details,
    );
    if (response) {
      params.telemetry.heartbeatToolResponse = response;
    }
  }
  if (!params.isError && params.result) {
    const media = extractToolResultMediaArtifact(params.result);
    if (media) {
      const mediaUrls = filterToolResultMediaUrls(params.toolName, media.mediaUrls, params.result);
      const seen = new Set(params.telemetry.toolMediaUrls);
      for (const url of mediaUrls) {
        if (!seen.has(url)) {
          seen.add(url);
          params.telemetry.toolMediaUrls.push(url);
        }
      }
      if (media.audioAsVoice) {
        params.telemetry.toolAudioAsVoice = true;
      }
    }
  }
  if (!isMessagingTool(params.toolName)) {
    return;
  }
  if (!isMessagingToolSendAction(params.toolName, params.args)) {
    return;
  }
  params.telemetry.didSendViaMessagingTool = true;
  const text = readFirstString(params.args, ["text", "message", "body", "content"]);
  if (text) {
    params.telemetry.messagingToolSentTexts.push(text);
  }
  const mediaUrls = collectArgMediaUrls(params.args);
  params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
  params.telemetry.messagingToolSentTargets.push({
    tool: params.toolName,
    provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
    accountId: readFirstString(params.args, ["accountId", "account_id"]),
    to: readFirstString(params.args, ["to", "target", "recipient"]),
    threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  } as MessagingToolSend);
}

// ─── Result projection ──────────────────────────────────────────────────────

function projectContentItems(result: unknown): DynamicToolCallOutputContentItem[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [{ type: "inputText", text: String(result) }];
  }
  const obj = result as Record<string, unknown>;
  const items: DynamicToolCallOutputContentItem[] = [];
  const content = obj.content;
  if (typeof content === "string") {
    items.push({ type: "inputText", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        items.push({ type: "inputText", text: b.text });
      } else if (b.type === "image_url" && typeof b.image_url === "string") {
        items.push({ type: "inputImage", imageUrl: b.image_url });
      } else if (b.type === "image" && typeof b.url === "string") {
        items.push({ type: "inputImage", imageUrl: b.url });
      }
    }
  }
  if (items.length === 0) {
    if (typeof obj.text === "string") {
      items.push({ type: "inputText", text: obj.text });
    } else {
      items.push({ type: "inputText", text: stringify(obj) });
    }
  }
  return items;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isResultError(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const obj = result as Record<string, unknown>;
  return obj.isError === true || obj.is_error === true;
}

function readFirstString(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function collectArgMediaUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ["mediaUrls", "mediaUrl", "imageUrls", "imageUrl", "url", "urls"]) {
    const v = args[key];
    if (typeof v === "string") {
      urls.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          urls.push(item);
        }
      }
    }
  }
  return urls;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorResponse(message: string): DynamicToolCallResponse {
  return { contentItems: [{ type: "inputText", text: message }], success: false };
}
