import {
  extractToolErrorMessage,
  extractToolResultText,
  sanitizeToolResult,
} from "../pi-embedded-subscribe.tools.js";
import { normalizeToolName } from "../tool-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSdkToolName(
  raw: string,
  mcpServerName: string,
): { name: string; rawName: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { name: "tool", rawName: "" };
  const parts = trimmed.split("__");
  const withoutMcpPrefix =
    parts.length >= 3 && parts[0] === "mcp" && parts[1] === mcpServerName
      ? parts.slice(2).join("__")
      : parts.length >= 3 && parts[0] === "mcp"
        ? parts.slice(2).join("__")
        : trimmed;
  return { name: normalizeToolName(withoutMcpPrefix), rawName: trimmed };
}

export type SdkHookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact";

export type SdkHookContext = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
};

export type SdkHookCallback = (
  input: unknown,
  toolUseId: unknown,
  context: unknown,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type SdkHookCallbackMatcher = {
  matcher?: string;
  hooks: SdkHookCallback[];
  timeout?: number;
};

export type SdkHooksConfig = Partial<Record<SdkHookEventName, SdkHookCallbackMatcher[]>>;

function sanitizeHookToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return sanitizeToolResult(value);
}

function extractHookToolText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return extractToolResultText(value) ?? undefined;
}

export function buildClawdbrainSdkHooks(params: {
  mcpServerName: string;
  emitEvent: (stream: string, data: Record<string, unknown>) => void;
  onToolResult?: (payload: { text?: string }) => void | Promise<void>;
}): SdkHooksConfig {
  const emitHook = (hookEventName: SdkHookEventName, input: unknown, toolUseId: unknown) => {
    const payload = isRecord(input) ? input : { input };
    params.emitEvent("hook", { hookEventName, toolUseId, ...payload });
  };

  const toolStartHook: SdkHookCallback = async (input, toolUseId) => {
    emitHook("PreToolUse", input, toolUseId);

    const record = isRecord(input) ? input : undefined;
    const rawName = typeof record?.tool_name === "string" ? record.tool_name : "";
    const normalized = normalizeSdkToolName(rawName, params.mcpServerName);
    const args = sanitizeHookToolPayload(record?.tool_input);

    params.emitEvent("tool", {
      phase: "start",
      name: normalized.name,
      ...(normalized.rawName ? { rawName: normalized.rawName } : {}),
      toolCallId: typeof toolUseId === "string" ? toolUseId : undefined,
      args: isRecord(args) ? args : args !== undefined ? { value: args } : undefined,
    });

    return {};
  };

  const toolResultHook: SdkHookCallback = async (input, toolUseId) => {
    emitHook("PostToolUse", input, toolUseId);

    const record = isRecord(input) ? input : undefined;
    const rawName = typeof record?.tool_name === "string" ? record.tool_name : "";
    const normalized = normalizeSdkToolName(rawName, params.mcpServerName);
    const resultRaw = record?.tool_response;
    const sanitized = sanitizeHookToolPayload(resultRaw);
    const resultText = extractHookToolText(resultRaw);

    params.emitEvent("tool", {
      phase: "result",
      name: normalized.name,
      ...(normalized.rawName ? { rawName: normalized.rawName } : {}),
      toolCallId: typeof toolUseId === "string" ? toolUseId : undefined,
      isError: false,
      result: sanitized,
      ...(resultText ? { resultText } : {}),
    });

    if (resultText && params.onToolResult) {
      try {
        await params.onToolResult({ text: resultText });
      } catch {
        // ignore callback errors
      }
    }

    return {};
  };

  const toolFailureHook: SdkHookCallback = async (input, toolUseId) => {
    emitHook("PostToolUseFailure", input, toolUseId);

    const record = isRecord(input) ? input : undefined;
    const rawName = typeof record?.tool_name === "string" ? record.tool_name : "";
    const normalized = normalizeSdkToolName(rawName, params.mcpServerName);
    const error = extractToolErrorMessage(record ?? input);

    params.emitEvent("tool", {
      phase: "result",
      name: normalized.name,
      ...(normalized.rawName ? { rawName: normalized.rawName } : {}),
      toolCallId: typeof toolUseId === "string" ? toolUseId : undefined,
      isError: true,
      ...(error ? { error } : {}),
    });

    if (error && params.onToolResult) {
      try {
        await params.onToolResult({ text: error });
      } catch {
        // ignore callback errors
      }
    }

    return {};
  };

  const passthroughHook =
    (hookEventName: SdkHookEventName): SdkHookCallback =>
    async (input, toolUseId, context) => {
      void context;
      emitHook(hookEventName, input, toolUseId);
      return {};
    };

  return {
    PreToolUse: [{ hooks: [toolStartHook] }],
    PostToolUse: [{ hooks: [toolResultHook] }],
    PostToolUseFailure: [{ hooks: [toolFailureHook] }],
    Notification: [{ hooks: [passthroughHook("Notification")] }],
    SessionStart: [{ hooks: [passthroughHook("SessionStart")] }],
    SessionEnd: [{ hooks: [passthroughHook("SessionEnd")] }],
    UserPromptSubmit: [{ hooks: [passthroughHook("UserPromptSubmit")] }],
    Stop: [{ hooks: [passthroughHook("Stop")] }],
    SubagentStart: [{ hooks: [passthroughHook("SubagentStart")] }],
    SubagentStop: [{ hooks: [passthroughHook("SubagentStop")] }],
    PreCompact: [{ hooks: [passthroughHook("PreCompact")] }],
  };
}
