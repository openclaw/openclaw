import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { readCodexAsyncQuestions } from "./async-questions.js";
import { codexProviderRefusalDetails, readCodexProviderRefusal } from "./event-projector-values.js";
import type { CodexThread, CodexTurn, JsonValue } from "./protocol.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const CODEX_HISTORY_IMPORT_MAX_MESSAGES = 200;
const CODEX_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES = 64 * 1024;
const CODEX_HISTORY_TRUNCATION_SUFFIX = "\n\n[Message truncated during Codex history import.]";
const CODEX_HISTORY_ASSISTANT_API = "openai-chatgpt-responses" as const;
const CODEX_HISTORY_ASSISTANT_PROVIDER = "openai";
const CODEX_HISTORY_ASSISTANT_MODEL = "native-history";
const CODEX_HISTORY_ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type CodexThreadHistoryImportResult = {
  importedMessages: number;
  omittedMessages: number;
};

type BoundedCodexThreadHistoryProjection = CodexThreadHistoryImportResult & {
  responseItems: JsonValue[];
  transcriptMessages: AgentMessage[];
};

type ProjectedCodexHistoryMessage = {
  message: AgentMessage;
  responseItem: JsonValue;
  messageBytes: number;
};

function projectCodexHistoryMessage(
  message: Extract<AgentMessage, { role: "user" | "assistant" }>,
  text: string,
): ProjectedCodexHistoryMessage {
  const phase =
    message.role === "assistant" &&
    "phase" in message &&
    (message.phase === "commentary" || message.phase === "final_answer")
      ? message.phase
      : undefined;
  return {
    message,
    responseItem: {
      type: "message",
      role: message.role,
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text }],
      ...(phase ? { phase } : {}),
    },
    messageBytes:
      Buffer.byteLength(text, "utf8") +
      (message.role === "assistant"
        ? Buffer.byteLength(message.errorMessage ?? "", "utf8") +
          (message.diagnostics ? Buffer.byteLength(JSON.stringify(message.diagnostics), "utf8") : 0)
        : 0),
  };
}

function normalizeImportedHistoryText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") <= CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(CODEX_HISTORY_TRUNCATION_SUFFIX, "utf8");
  const contentLimitBytes = Math.max(0, CODEX_HISTORY_IMPORT_MAX_MESSAGE_BYTES - suffixBytes);
  return `${truncateUtf8Prefix(text, contentLimitBytes)}${CODEX_HISTORY_TRUNCATION_SUFFIX}`;
}

export function projectCodexUserItemText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const value of item.content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const input = value as Record<string, unknown>;
    if (input.type === "text") {
      const text = normalizeImportedHistoryText(input.text);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (input.type === "image" || input.type === "localImage") {
      parts.push("[Image attachment]");
      continue;
    }
    if (input.type === "audio" || input.type === "localAudio" || input.type === "local_audio") {
      parts.push("[Audio attachment]");
    }
    if (input.type === "skill" || input.type === "mention") {
      const name = normalizeOptionalString(input.name);
      if (name) {
        parts.push(`${input.type === "skill" ? "$" : "@"}${name}`);
      }
    }
  }
  return normalizeImportedHistoryText(parts.join("\n"));
}

function selectTurnsThroughBoundary(
  thread: CodexThread,
  throughTurnId: string | null,
): NonNullable<CodexThread["turns"]> {
  if (throughTurnId === null) {
    return [];
  }
  const turns = thread.turns ?? [];
  const boundaryIndex = turns.findIndex((turn) => turn.id === throughTurnId);
  if (boundaryIndex < 0) {
    throw new Error(`Codex history boundary turn not found: ${throughTurnId}`);
  }
  const boundary = turns[boundaryIndex];
  if (
    boundary?.status !== "completed" &&
    boundary?.status !== "interrupted" &&
    boundary?.status !== "failed"
  ) {
    throw new Error(`Codex history boundary turn is not terminal: ${throughTurnId}`);
  }
  return turns.slice(0, boundaryIndex + 1);
}

function projectCodexThreadHistory(params: {
  thread: CodexThread;
  turns: CodexTurn[];
  importedAt: number;
  modelProvider?: string;
  includeErrorOnlyTurns?: boolean;
}): ProjectedCodexHistoryMessage[] {
  const projected: ProjectedCodexHistoryMessage[] = [];
  const threadTimestamp =
    typeof params.thread.createdAt === "number" && Number.isFinite(params.thread.createdAt)
      ? params.thread.createdAt * 1000
      : params.importedAt;
  let itemOffset = 0;
  for (const turn of params.turns) {
    const refusal =
      turn.status === "failed"
        ? readCodexProviderRefusal(turn.error?.message, turn.error?.codexErrorInfo, {
            misalignment: turn.error?.misalignment,
            nativeThreadId: params.thread.id,
            nativeTurnId: turn.id,
          })
        : undefined;
    let hasAssistantMessage = false;
    for (const value of turn.items) {
      const item = value;
      const itemId = normalizeOptionalString(item.id);
      const identity = `${turn.id}:${itemId ?? itemOffset}`;
      const timestampSeconds =
        item.type === "agentMessage"
          ? (turn.completedAt ?? turn.startedAt)
          : (turn.startedAt ?? turn.completedAt);
      const timestamp =
        typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)
          ? timestampSeconds * 1000 + itemOffset
          : threadTimestamp + itemOffset;
      const text =
        item.type === "userMessage"
          ? projectCodexUserItemText(item)
          : item.type === "agentMessage"
            ? normalizeImportedHistoryText(item.text)
            : undefined;
      const role =
        item.type === "userMessage"
          ? ("user" as const)
          : item.type === "agentMessage"
            ? ("assistant" as const)
            : undefined;
      itemOffset += 1;
      if (!text || !role) {
        continue;
      }
      const phase =
        item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
      const asyncDelivery = item.delivery === "async";
      const terminalAssistant = role === "assistant" && phase !== "commentary" && !asyncDelivery;
      hasAssistantMessage ||= terminalAssistant;
      const questions = asyncDelivery ? readCodexAsyncQuestions(item.questions) : undefined;
      const message =
        role === "assistant"
          ? attachCodexMirrorIdentity(
              {
                role,
                content: [{ type: "text", text }],
                api: CODEX_HISTORY_ASSISTANT_API,
                provider:
                  normalizeOptionalString(params.modelProvider) ??
                  normalizeOptionalString(params.thread.modelProvider) ??
                  CODEX_HISTORY_ASSISTANT_PROVIDER,
                model: CODEX_HISTORY_ASSISTANT_MODEL,
                usage: CODEX_HISTORY_ZERO_USAGE,
                stopReason:
                  turn.status === "interrupted"
                    ? "aborted"
                    : turn.status === "failed"
                      ? "error"
                      : "stop",
                ...(turn.status === "failed" && turn.error?.message
                  ? { errorMessage: turn.error.message }
                  : {}),
                ...(refusal && terminalAssistant
                  ? {
                      diagnostics: [
                        {
                          type: "provider_refusal",
                          timestamp,
                          details: codexProviderRefusalDetails(refusal),
                        },
                      ],
                    }
                  : {}),
                ...(phase ? { phase } : {}),
                ...(asyncDelivery && itemId
                  ? { openclawAsyncDelivery: { itemId, ...(questions ? { questions } : {}) } }
                  : {}),
                timestamp,
              } satisfies AssistantMessage,
              identity,
            )
          : attachCodexMirrorIdentity({ role, content: text, timestamp }, identity);
      projected.push(projectCodexHistoryMessage(message, text));
    }
    if (
      params.includeErrorOnlyTurns &&
      !hasAssistantMessage &&
      turn.status === "failed" &&
      turn.error?.message
    ) {
      const timestamp = (turn.completedAt ?? turn.startedAt ?? threadTimestamp / 1000) * 1000;
      const text = normalizeImportedHistoryText(turn.error.message) ?? "Codex turn failed.";
      const message: AssistantMessage = attachCodexMirrorIdentity(
        {
          role: "assistant",
          content: [],
          api: CODEX_HISTORY_ASSISTANT_API,
          provider:
            normalizeOptionalString(params.modelProvider) ??
            normalizeOptionalString(params.thread.modelProvider) ??
            CODEX_HISTORY_ASSISTANT_PROVIDER,
          model: CODEX_HISTORY_ASSISTANT_MODEL,
          usage: CODEX_HISTORY_ZERO_USAGE,
          stopReason: "error",
          errorMessage: text,
          ...(refusal
            ? {
                diagnostics: [
                  {
                    type: "provider_refusal",
                    timestamp,
                    details: codexProviderRefusalDetails(refusal),
                  },
                ],
              }
            : {}),
          timestamp,
        },
        `${turn.id}:assistant`,
      );
      projected.push(projectCodexHistoryMessage(message, ""));
    }
  }
  return projected;
}

function selectBoundedCodexHistoryTail(
  projected: ProjectedCodexHistoryMessage[],
): ProjectedCodexHistoryMessage[] {
  const selected: ProjectedCodexHistoryMessage[] = [];
  let selectedBytes = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const candidate = projected[index];
    if (!candidate) {
      continue;
    }
    if (
      selected.length >= CODEX_HISTORY_IMPORT_MAX_MESSAGES ||
      selectedBytes + candidate.messageBytes > CODEX_HISTORY_IMPORT_MAX_BYTES
    ) {
      break;
    }
    selected.push(candidate);
    selectedBytes += candidate.messageBytes;
  }
  return selected.toReversed();
}

/** Projects one terminal Codex history prefix into transcript and Responses API items. */
export function projectBoundedCodexThreadHistory(params: {
  thread: CodexThread;
  throughTurnId: string | null;
  importedAt: number;
  modelProvider?: string | null;
}): BoundedCodexThreadHistoryProjection {
  const projected = projectCodexThreadHistory({
    thread: params.thread,
    turns: selectTurnsThroughBoundary(params.thread, params.throughTurnId),
    importedAt: params.importedAt,
    includeErrorOnlyTurns: true,
    ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
  });
  const selected = selectBoundedCodexHistoryTail(projected);
  return {
    importedMessages: selected.length,
    omittedMessages: projected.length - selected.length,
    // Failed assistant fragments remain visible in operator transcripts, but
    // injecting them would permanently replay incomplete model output.
    responseItems: selected
      .filter(
        ({ message }) =>
          message.role !== "assistant" ||
          (message.stopReason !== "aborted" &&
            message.stopReason !== "error" &&
            !("openclawAsyncDelivery" in message)),
      )
      .map(({ responseItem }) => responseItem),
    transcriptMessages: selected.map(({ message }) => message),
  };
}

/** Projects only visible local user/assistant messages through the same bounded history policy. */
export function projectBoundedCodexVisibleSessionHistory(
  entries: readonly SessionTranscriptMessageEntry[],
): JsonValue[] {
  const projected: ProjectedCodexHistoryMessage[] = [];
  for (const { message } of entries) {
    if ((message.role !== "user" && message.role !== "assistant") || !("content" in message)) {
      continue;
    }
    if (
      message.role === "assistant" &&
      (message.stopReason === "aborted" ||
        message.stopReason === "error" ||
        "openclawAsyncDelivery" in message)
    ) {
      continue;
    }
    const content = message.content;
    const text = normalizeImportedHistoryText(
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part) =>
                part && typeof part === "object" && "text" in part && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : undefined,
    );
    if (!text) {
      continue;
    }
    projected.push(projectCodexHistoryMessage(message, text));
  }
  return selectBoundedCodexHistoryTail(projected).map(({ responseItem }) => responseItem);
}
