import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  extractQaContentText,
  readQaMessageToolCalls,
  readQaTranscriptMessages,
} from "./runtime-transcript.js";
import { projectQaToolActivity } from "./tool-activity.js";

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
  // OpenClaw mirrors provider arguments separately; a placeholder input can be empty.
  for (const { block, id, tool, args } of readQaMessageToolCalls(message, {
    preferArguments: true,
  })) {
    if (!tool) {
      continue;
    }
    calls.push({
      ...block,
      type: "toolCall",
      id,
      name: tool,
      arguments: args,
    });
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
  const isToolEnvelope =
    (message.role === "tool" || message.role === "toolResult") && message.content !== undefined;
  // The tool envelope owns its result; nested display blocks are its payload.
  const blocks = isToolEnvelope ? [message] : Array.isArray(message.content) ? message.content : [];
  const idFields = isToolEnvelope
    ? ["tool_call_id", "toolCallId", "toolUseId", "id"]
    : ["tool_use_id", "toolUseId", "tool_call_id", "toolCallId", "id"];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    const type = normalizeOptionalString(block.type)?.toLowerCase();
    if (
      !isToolEnvelope &&
      type !== "tool_result" &&
      type !== "toolresult" &&
      type !== "tool_result_error"
    ) {
      continue;
    }
    const text = isToolEnvelope
      ? extractTranscriptText(block.content)
      : stringifyTranscriptToolResult(
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
      toolCallId: idFields.map((field) => normalizeOptionalString(block[field])).find(Boolean),
      toolName: blockTool,
      content: text,
      isError:
        (!isToolEnvelope && type === "tool_result_error") ||
        block.isError === true ||
        block.is_error === true,
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
      const call = {
        id: activity.toolCallId,
        tool: activity.toolName,
        args: activity.input,
      };
      const text = extractTranscriptText(activity.result?.content);
      const result =
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
