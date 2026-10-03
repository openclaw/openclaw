import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  extractQaContentText,
  readQaMessageFunctionCalls,
  readQaTranscriptMessages,
} from "./runtime-transcript.js";
import { projectQaToolActivity } from "./tool-activity.js";

type QaRuntimeToolFixtureTranscriptToolCall = {
  id?: string;
  tool: string;
  args: unknown;
};

type QaRuntimeToolFixtureTranscriptToolResult = {
  id?: string;
  tool?: string;
  text: string;
  failure: boolean;
  hardFailure: boolean;
};

const RUNTIME_PATCH_WORKSPACE_DENIAL_RE =
  /(?:path\s+escapes\s+(?:the\s+)?(?:sandbox|workspace)(?:\s+root)?|outside(?:\s+of)?\s+(?:the\s+)?(?:project|sandbox|workspace|allowed\s+(?:sandbox|workspace|root)|writable\s+roots?)(?:\s+root)?|workspace[- ]only|permission\s+denied|operation\s+not\s+permitted|\bos\s+error\s+1\b|\b(?:EACCES|EPERM)\b)/iu;

export function isHardFailureToolOutputText(text: string) {
  return (
    /\b(?:ENOENT|EACCES|EPERM)\b/u.test(text) ||
    /(?:^|\n)\s*(?:Error|Exception|Failed):/u.test(text) ||
    /\b(?:disabled|forbidden|no provider|no such file|permission denied|unavailable)\b/iu.test(text)
  );
}

export function isWorkspaceBoundaryFailureToolOutput(text: unknown) {
  return typeof text === "string" && RUNTIME_PATCH_WORKSPACE_DENIAL_RE.test(text);
}

function stringifyTranscriptToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractTranscriptText(value: unknown): string {
  return extractQaContentText(
    value,
    (block) =>
      normalizeOptionalString(block.text) ??
      normalizeOptionalString(block.content) ??
      normalizeOptionalString(block.message) ??
      normalizeOptionalString(block.error),
  );
}

function extractTranscriptToolCalls(message: Record<string, unknown>): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  const rawContent = message.content;
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!isRecord(block)) {
        continue;
      }
      const type = normalizeOptionalString(block.type)?.toLowerCase();
      if (type !== "tool_use" && type !== "toolcall" && type !== "tool_call") {
        continue;
      }
      const tool = normalizeOptionalString(block.name);
      if (!tool) {
        continue;
      }
      calls.push({
        ...block,
        type: "toolCall",
        id:
          normalizeOptionalString(block.id) ??
          normalizeOptionalString(block.toolCallId) ??
          normalizeOptionalString(block.toolUseId),
        name: tool,
        // OpenClaw mirrors provider arguments separately; a placeholder input
        // can be empty even though arguments contains the executed patch.
        arguments: block.arguments ?? block.input ?? block.args ?? block.payload ?? null,
      });
    }
  }

  for (const call of readQaMessageFunctionCalls(message)) {
    if (call.tool) {
      calls.push({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args });
    }
  }
  return calls;
}

const FAILURE_LIKE_TOOL_RESULT_RE =
  /\b(?:denied|enoent|error|exception|fail(?:ed|ure)?|forbidden|invalid|missing|not found|permission|reject(?:ed|ion)?)\b/iu;

const REQUIRED_FIELD_TOOL_RESULT_RE =
  /(?:^|[\n:,({[]\s*)["']?[A-Z_][A-Z0-9_.[\]-]*["']?\s+(?:is\s+)?required\b/iu;

export function classifyToolResultFailure(params: {
  type?: string;
  text: string;
  isError?: unknown;
  is_error?: unknown;
}) {
  const structuredFailure =
    params.type === "tool_result_error" || params.isError === true || params.is_error === true;
  const hardFailure =
    structuredFailure ||
    isHardFailureToolOutputText(params.text) ||
    isWorkspaceBoundaryFailureToolOutput(params.text);
  return {
    hardFailure,
    failure:
      hardFailure ||
      FAILURE_LIKE_TOOL_RESULT_RE.test(params.text) ||
      REQUIRED_FIELD_TOOL_RESULT_RE.test(params.text),
  };
}

function extractTranscriptToolResults(message: Record<string, unknown>): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const tool =
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool);
  if ((message.role === "tool" || message.role === "toolResult") && message.content !== undefined) {
    const text = extractTranscriptText(message.content);
    results.push({
      ...message,
      role: "toolResult",
      toolCallId:
        normalizeOptionalString(message.tool_call_id) ??
        normalizeOptionalString(message.toolCallId) ??
        normalizeOptionalString(message.toolUseId) ??
        normalizeOptionalString(message.id),
      toolName: tool,
      content: text,
      isError: message.isError === true || message.is_error === true,
    });
    // The tool envelope owns its result; nested display blocks are its payload.
    return results;
  }

  const rawContent = message.content;
  if (!Array.isArray(rawContent)) {
    return results;
  }
  for (const block of rawContent) {
    if (!isRecord(block)) {
      continue;
    }
    const type = normalizeOptionalString(block.type)?.toLowerCase();
    if (type !== "tool_result" && type !== "toolresult" && type !== "tool_result_error") {
      continue;
    }
    const text = stringifyTranscriptToolResult(
      block.content ?? block.text ?? block.result ?? block.error ?? block.message,
    );
    const blockTool =
      normalizeOptionalString(block.toolName) ??
      normalizeOptionalString(block.tool_name) ??
      normalizeOptionalString(block.name) ??
      normalizeOptionalString(block.tool);
    results.push({
      ...block,
      role: "toolResult",
      toolCallId:
        normalizeOptionalString(block.tool_use_id) ??
        normalizeOptionalString(block.toolUseId) ??
        normalizeOptionalString(block.tool_call_id) ??
        normalizeOptionalString(block.toolCallId) ??
        normalizeOptionalString(block.id),
      toolName: blockTool,
      content: text,
      isError: type === "tool_result_error" || block.isError === true || block.is_error === true,
    });
  }
  return results;
}

export function readTranscriptToolEvidence(transcriptBytes: string, toolName: string) {
  // Adapt provider wire shapes once; the shared projection owns correlation and settlement.
  const messages: Record<string, unknown>[] = [];
  for (const message of readQaTranscriptMessages(transcriptBytes)) {
    if (message.role === "custom") {
      messages.push(message);
      continue;
    }
    const calls = message.role === "assistant" ? extractTranscriptToolCalls(message) : [];
    const results = extractTranscriptToolResults(message);
    if (calls.length === 0 && results.length === 0) {
      messages.push(message);
      continue;
    }
    if (calls.length > 0) {
      messages.push({ ...message, role: "assistant", content: calls });
    }
    messages.push(...results);
  }
  const evidence = projectQaToolActivity(messages)
    .filter((activity) => activity.kind === "tool" && activity.toolName === toolName)
    .map((activity) => {
      const call: QaRuntimeToolFixtureTranscriptToolCall = {
        id: activity.toolCallId,
        tool: activity.toolName,
        args: activity.input,
      };
      const text = extractTranscriptText(activity.result?.content);
      const result: QaRuntimeToolFixtureTranscriptToolResult | undefined =
        activity.completed && text
          ? {
              id: activity.toolCallId,
              tool: activity.toolName,
              text,
              ...classifyToolResultFailure({ text, isError: !activity.successful }),
            }
          : undefined;
      return { call, result };
    });
  const linkedEvidence = evidence.find(({ result }) => result);
  const outputResult = linkedEvidence?.result;
  return {
    plannedRequest: evidence[0]?.call,
    executedRequest: linkedEvidence?.call,
    outputRequest: outputResult,
    failureOutputRequest: outputResult?.failure ? outputResult : undefined,
  };
}
