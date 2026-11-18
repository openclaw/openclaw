/** Trusted turn-level model-call diagnostics for the Claude Code CLI runtime. */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import { hasInternalDiagnosticEventListeners } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventPrivateData,
  type DiagnosticModelCallContent,
} from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { CliOutput, CliUsage } from "../cli-output-contracts.js";
import { isClaudeToolUseBlockType } from "../cli-output-records.js";
import { isFailoverError } from "../failover-error.js";
import type { PreparedCliRunContext } from "./types.js";

const MAX_CAPTURED_CONTENT_BYTES = 128 * 1024;
const FALLBACK_RESPONSE_RESERVE_BYTES = 16 * 1024;
const MAX_CAPTURED_OUTPUT_MESSAGES = 200;
const MAX_CAPTURED_OUTPUT_BLOCKS = 200;
const TRUNCATED_CONTENT_SUFFIX = "...(truncated)";
// One maximal tool-call block per envelope plus stopReason is the largest
// structure possible under the shared 200-envelope/item caps.
const MAX_CAPTURED_OUTPUT_STRUCTURE_BYTES = Buffer.byteLength(
  JSON.stringify(
    Array.from({ length: MAX_CAPTURED_OUTPUT_MESSAGES }, () => ({
      role: "assistant",
      content: [{ type: "tool_call", name: "", id: "" }],
      stopReason: "",
    })),
  ),
  "utf8",
);

type DiagnosticContentBudget = {
  remainingBytes: number;
  remainingItems: number;
  fallbackReserveBytes: number;
  fallbackReserveItems: number;
  truncated: boolean;
};

type DiagnosticAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call"; name: string; id?: string };
type DiagnosticAssistantMessage = {
  role: "assistant";
  content: DiagnosticAssistantBlock[];
  stopReason?: string;
};
type ParsedAssistantMessage = {
  content: (DiagnosticAssistantBlock | undefined)[];
  truncated: boolean;
  stopReason?: string;
};

function serializedStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

const TRUNCATED_CONTENT_SUFFIX_BYTES = serializedStringContentBytes(TRUNCATED_CONTENT_SUFFIX);

function truncateSerializedStringSafe(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (serializedStringContentBytes(value) <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  let captured = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf16Safe(value, middle);
    if (serializedStringContentBytes(candidate) <= maxBytes) {
      captured = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return captured;
}

function releaseFallbackReserve(budget: DiagnosticContentBudget): void {
  budget.remainingBytes += budget.fallbackReserveBytes;
  budget.remainingItems += budget.fallbackReserveItems;
  budget.fallbackReserveBytes = 0;
  budget.fallbackReserveItems = 0;
}

function captureTextWithinBudget(
  value: string,
  budget: DiagnosticContentBudget,
): string | undefined {
  if (budget.remainingBytes <= 0) {
    budget.truncated = true;
    return undefined;
  }
  const valueBytes = serializedStringContentBytes(value);
  if (valueBytes <= budget.remainingBytes) {
    budget.remainingBytes -= valueBytes;
    return value;
  }
  const suffix = truncateSerializedStringSafe(TRUNCATED_CONTENT_SUFFIX, budget.remainingBytes);
  const prefixBudget = Math.max(0, budget.remainingBytes - serializedStringContentBytes(suffix));
  const captured = `${truncateSerializedStringSafe(value, prefixBudget)}${suffix}`;
  budget.remainingBytes -= serializedStringContentBytes(captured);
  budget.truncated = true;
  return captured;
}

function captureBoundedText(value: string): string {
  const budget = {
    remainingBytes: MAX_CAPTURED_CONTENT_BYTES,
    remainingItems: 1,
    fallbackReserveBytes: 0,
    fallbackReserveItems: 0,
    truncated: false,
  };
  return captureTextWithinBudget(value, budget) ?? "";
}

function parseAssistantContentBlock(block: unknown): DiagnosticAssistantBlock | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking };
  }
  if (isClaudeToolUseBlockType(block.type) && typeof block.name === "string") {
    return {
      type: "tool_call",
      name: block.name,
      ...(typeof block.id === "string" ? { id: block.id } : {}),
    };
  }
  return undefined;
}

function assistantMessageHasText(message: Pick<ParsedAssistantMessage, "content">): boolean {
  return message.content.some((block) => block?.type === "text" && block.text.length > 0);
}

// Claude's assistant envelopes can contain native tool arguments and opaque
// thinking signatures. Keep only the visible response blocks OpenClaw can
// represent accurately; external harness tool spans stay metadata-only.
function parseClaudeAssistantMessage(message: unknown): ParsedAssistantMessage | undefined {
  if (!isRecord(message) || message.content === "") {
    return undefined;
  }
  const rawContent = message.content;
  const blocks = Array.isArray(rawContent) ? rawContent : undefined;
  return {
    content:
      typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : (blocks?.slice(0, MAX_CAPTURED_OUTPUT_BLOCKS).map(parseAssistantContentBlock) ?? []),
    truncated: (blocks?.length ?? 0) > MAX_CAPTURED_OUTPUT_BLOCKS,
    ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
  };
}

function normalizeClaudeAssistantMessage(
  message: ParsedAssistantMessage,
  budget: DiagnosticContentBudget,
): DiagnosticAssistantMessage | undefined {
  const content: DiagnosticAssistantBlock[] = [];
  budget.truncated ||= message.truncated;
  for (const [index, sourceBlock] of message.content.entries()) {
    let block: DiagnosticAssistantBlock | undefined;
    if (sourceBlock?.type === "text" && sourceBlock.text.length > 0) {
      releaseFallbackReserve(budget);
      const text = captureTextWithinBudget(sourceBlock.text, budget);
      block = text === undefined ? undefined : { type: "text", text };
    } else if (sourceBlock?.type === "thinking") {
      const thinking = captureTextWithinBudget(sourceBlock.thinking, budget);
      block = thinking === undefined ? undefined : { type: "thinking", thinking };
    } else if (sourceBlock?.type === "tool_call") {
      const name = captureTextWithinBudget(sourceBlock.name, budget);
      if (name !== undefined) {
        const id =
          sourceBlock.id !== undefined
            ? captureTextWithinBudget(sourceBlock.id, budget)
            : undefined;
        block = { type: "tool_call", name, ...(id !== undefined ? { id } : {}) };
      }
    }
    if (block) {
      if (budget.remainingItems > 0) {
        content.push(block);
        budget.remainingItems -= 1;
      } else {
        budget.truncated = true;
      }
    }
    if (budget.remainingBytes <= 0 || budget.remainingItems <= 0) {
      if (message.content.slice(index + 1).some((entry) => entry !== undefined)) {
        budget.truncated = true;
      }
      break;
    }
  }
  if (content.length === 0) {
    return undefined;
  }
  const stopReason =
    message.stopReason !== undefined
      ? captureTextWithinBudget(message.stopReason, budget)
      : undefined;
  return {
    role: "assistant",
    content,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function appendOutputTruncationMarker(messages: DiagnosticAssistantMessage[]): void {
  const marker: DiagnosticAssistantBlock = { type: "text", text: TRUNCATED_CONTENT_SUFFIX };
  if (messages.length < MAX_CAPTURED_OUTPUT_MESSAGES) {
    messages.push({ role: "assistant", content: [marker] });
    return;
  }
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex]!;
  messages[lastIndex] = {
    ...lastMessage,
    content: [...lastMessage.content, marker],
  };
}

function privateData(params: {
  modelContent?: DiagnosticModelCallContent;
  errorMessage?: string;
}): DiagnosticEventPrivateData | undefined {
  if (!params.modelContent && !params.errorMessage) {
    return undefined;
  }
  return {
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
    ...(params.modelContent ? { modelContent: params.modelContent } : {}),
  };
}

function usageField(usage: CliUsage | undefined): { usage?: CliUsage } {
  return usage ? { usage } : {};
}

/** Creates one exactly-once Claude CLI model-call lifecycle for a prepared turn. */
export function createClaudeCliModelCallDiagnostics(params: {
  context: PreparedCliRunContext;
  prompt: string;
  systemPrompt?: string;
  transport: "paired-node-cli" | "stdio" | "stdio-live";
}) {
  // Listener registration is process-stable after plugin startup. This attempt-local
  // snapshot avoids trace ids, capture buffers, and byte accounting when nobody consumes them.
  if (
    params.context.backendResolved.id !== "claude-cli" ||
    !areDiagnosticsEnabledForProcess() ||
    !hasInternalDiagnosticEventListeners()
  ) {
    return undefined;
  }

  const capture = resolveDiagnosticModelContentCapturePolicy(
    params.context.params.config ?? params.context.contextEngineConfig,
  );
  const contextWindow = params.context.contextWindowInfo;
  const trace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const baseFields = {
    runId: params.context.params.runId,
    ...(params.context.params.agentId ? { agentId: params.context.params.agentId } : {}),
    callId: `${params.context.params.runId}:claude-cli:${crypto.randomUUID()}`,
    ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
    sessionId: params.context.params.sessionId,
    provider:
      params.context.backendResolved.modelProvider ??
      params.context.params.modelProvider ??
      "anthropic",
    model: params.context.normalizedModel,
    api: "claude-code",
    transport: params.transport,
    observationUnit: "turn" as const,
    ...(contextWindow
      ? {
          contextTokenBudget: contextWindow.tokens,
          contextWindowSource: contextWindow.source,
          ...(contextWindow.referenceTokens
            ? { contextWindowReferenceTokens: contextWindow.referenceTokens }
            : {}),
        }
      : {}),
    promptStats: {
      inputMessagesCount: 1,
      inputMessagesChars: params.prompt.length,
      ...(params.systemPrompt ? { systemPromptChars: params.systemPrompt.length } : {}),
      totalChars: params.prompt.length + (params.systemPrompt?.length ?? 0),
    },
    trace,
  };
  const capturedAssistantMessages: DiagnosticAssistantMessage[] = [];
  const outputContentBudget: DiagnosticContentBudget = {
    remainingBytes:
      MAX_CAPTURED_CONTENT_BYTES -
      MAX_CAPTURED_OUTPUT_STRUCTURE_BYTES -
      TRUNCATED_CONTENT_SUFFIX_BYTES -
      FALLBACK_RESPONSE_RESERVE_BYTES,
    // One item stays available for the truncation marker; one more is held
    // separately for the final visible fallback until normal text arrives.
    remainingItems: MAX_CAPTURED_OUTPUT_BLOCKS - 2,
    fallbackReserveBytes: FALLBACK_RESPONSE_RESERVE_BYTES,
    fallbackReserveItems: 1,
    truncated: false,
  };
  let started = false;
  let terminalEmitted = false;
  let startedAt = 0;
  let requestPayloadBytes: number | undefined;
  let responseStreamBytes = 0;
  let firstCliOutputAt: number | undefined;
  let observedUsage: CliUsage | undefined;
  let observedTerminalUsage: CliUsage | undefined;

  const baseModelContent = (): DiagnosticModelCallContent | undefined => {
    if (!capture.anyModelContent) {
      return undefined;
    }
    const content: DiagnosticModelCallContent = {
      ...(capture.inputMessages
        ? {
            inputMessages: [
              {
                role: "user",
                content: [{ type: "text", text: captureBoundedText(params.prompt) }],
              },
            ],
          }
        : {}),
      ...(capture.systemPrompt && params.systemPrompt
        ? { systemPrompt: captureBoundedText(params.systemPrompt) }
        : {}),
    };
    return Object.keys(content).length > 0 ? content : undefined;
  };
  const outputMessages = (output?: CliOutput): unknown => {
    const messages = capturedAssistantMessages.slice();
    const responseText = output?.rawText ?? output?.text;
    if (
      !messages.some(assistantMessageHasText) &&
      responseText &&
      messages.length < MAX_CAPTURED_OUTPUT_MESSAGES
    ) {
      const fallback = normalizeClaudeAssistantMessage(
        { content: [{ type: "text", text: responseText }], truncated: false },
        outputContentBudget,
      );
      if (fallback) {
        messages.push(fallback);
      }
    }
    if (outputContentBudget.truncated) {
      appendOutputTruncationMarker(messages);
    }
    return messages;
  };
  const completedModelContent = (output?: CliOutput): DiagnosticModelCallContent | undefined => {
    const base = baseModelContent();
    if (!capture.outputMessages) {
      return base;
    }
    return {
      ...base,
      outputMessages: outputMessages(output),
    };
  };
  const sizeTimingFields = () => ({
    ...(requestPayloadBytes !== undefined ? { requestPayloadBytes } : {}),
    ...(responseStreamBytes > 0 ? { responseStreamBytes } : {}),
    ...(firstCliOutputAt !== undefined
      ? { timeToFirstByteMs: Math.max(0, firstCliOutputAt - startedAt) }
      : {}),
  });

  return {
    emitStarted: (): void => {
      if (started) {
        return;
      }
      started = true;
      startedAt = Date.now();
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          ...baseFields,
        },
        privateData({ modelContent: baseModelContent() }),
      );
    },
    observeRequestPayload: (payload: string): void => {
      requestPayloadBytes = Buffer.byteLength(payload, "utf8");
    },
    observeCliOutput: (
      chunk: string,
      stream: "stderr" | "stdout",
      knownByteLength?: number,
    ): void => {
      if (!chunk) {
        return;
      }
      firstCliOutputAt ??= Date.now();
      if (stream === "stdout") {
        responseStreamBytes += knownByteLength ?? Buffer.byteLength(chunk, "utf8");
      }
    },
    observeAssistantMessage: (message: unknown): void => {
      if (!capture.outputMessages) {
        return;
      }
      if (
        capturedAssistantMessages.length >= MAX_CAPTURED_OUTPUT_MESSAGES - 1 ||
        ((outputContentBudget.remainingBytes <= 0 || outputContentBudget.remainingItems <= 0) &&
          outputContentBudget.fallbackReserveItems <= 0)
      ) {
        outputContentBudget.truncated = true;
        return;
      }
      const parsed = parseClaudeAssistantMessage(message);
      if (
        (outputContentBudget.remainingBytes <= 0 || outputContentBudget.remainingItems <= 0) &&
        !(outputContentBudget.fallbackReserveItems > 0 && parsed && assistantMessageHasText(parsed))
      ) {
        outputContentBudget.truncated = true;
        return;
      }
      const normalized = parsed && normalizeClaudeAssistantMessage(parsed, outputContentBudget);
      if (normalized) {
        capturedAssistantMessages.push(normalized);
      }
    },
    observeUsage: (usage: CliUsage, terminal: boolean): void => {
      observedUsage = usage;
      if (terminal) {
        observedTerminalUsage = usage;
      }
    },
    emitCompleted: (output: CliOutput): void => {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.completed",
          ...baseFields,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...sizeTimingFields(),
          ...usageField(
            output.diagnosticUsage ?? observedTerminalUsage ?? output.usage ?? observedUsage,
          ),
        },
        privateData({ modelContent: completedModelContent(output) }),
      );
    },
    emitError: (error: unknown): void => {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      const failureKind =
        isFailoverError(error) && error.reason === "timeout"
          ? "timeout"
          : (diagnosticErrorFailureKind(error) ??
            (params.context.params.abortSignal?.aborted ? "aborted" : undefined));
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          ...baseFields,
          durationMs: Math.max(0, Date.now() - startedAt),
          errorCategory:
            (isFailoverError(error) ? error.reason : undefined) ??
            failureKind ??
            diagnosticErrorCategory(error),
          ...(failureKind ? { failureKind } : {}),
          ...sizeTimingFields(),
          ...usageField(observedTerminalUsage ?? observedUsage),
        },
        privateData({
          modelContent: completedModelContent(),
          errorMessage: diagnosticErrorMessage(error),
        }),
      );
    },
  };
}
