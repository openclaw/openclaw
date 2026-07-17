/** Trusted turn-level model-call diagnostics for the Claude Code CLI runtime. */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventPrivateData,
  type DiagnosticModelCallContent,
} from "../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  resolveDiagnosticModelContentCapturePolicy,
} from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { CliOutput, CliUsage } from "../cli-output.js";
import { isFailoverError } from "../failover-error.js";
import type { PreparedCliRunContext } from "./types.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];
type ModelCallFailureKind = Extract<
  TrustedDiagnosticEventInput,
  { type: "model.call.error" }
>["failureKind"];

function assistantContentBlock(block: unknown): Record<string, unknown> | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { type: "thinking", thinking: block.thinking };
  }
  if (
    (block.type === "tool_use" ||
      block.type === "server_tool_use" ||
      block.type === "mcp_tool_use") &&
    typeof block.name === "string"
  ) {
    return {
      type: "tool_call",
      name: block.name,
      ...(typeof block.id === "string" ? { id: block.id } : {}),
    };
  }
  return undefined;
}

// Claude's assistant envelopes can contain native tool arguments and opaque
// thinking signatures. Keep only the visible response blocks OpenClaw can
// represent accurately; external harness tool spans stay metadata-only.
function normalizeClaudeAssistantMessage(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content
            .map(assistantContentBlock)
            .filter((block): block is Record<string, unknown> => Boolean(block))
        : [];
  if (content.length === 0) {
    return undefined;
  }
  return {
    role: "assistant",
    content,
    ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
  };
}

function hasTextContent(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
      ),
  );
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

function failureKindForClaudeCli(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): ModelCallFailureKind | undefined {
  if (isFailoverError(error) && error.reason === "timeout") {
    return "timeout";
  }
  const inferred = diagnosticErrorFailureKind(error);
  if (inferred) {
    return inferred;
  }
  return abortSignal?.aborted ? "aborted" : undefined;
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
  now?: () => number;
}) {
  if (params.context.backendResolved.id !== "claude-cli") {
    return undefined;
  }

  const now = params.now ?? (() => Date.now());
  const capture = resolveDiagnosticModelContentCapturePolicy(
    params.context.params.config ?? params.context.contextEngineConfig,
  );
  const contextWindow = params.context.contextWindowInfo;
  const trace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const baseFields = {
    runId: params.context.params.runId,
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
  const capturedAssistantMessages: Record<string, unknown>[] = [];
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
            inputMessages: cloneDiagnosticContentValue([
              { role: "user", content: [{ type: "text", text: params.prompt }] },
            ]),
          }
        : {}),
      ...(capture.systemPrompt && params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    };
    return Object.keys(content).length > 0 ? content : undefined;
  };
  const outputMessages = (output?: CliOutput): unknown => {
    const messages = capturedAssistantMessages.slice();
    const responseText = output?.rawText ?? output?.text;
    if (!hasTextContent(messages) && responseText) {
      messages.push({ role: "assistant", content: [{ type: "text", text: responseText }] });
    }
    return cloneDiagnosticContentValue(messages);
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
      startedAt = now();
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
    observeCliOutput: (chunk: string, stream: "stderr" | "stdout"): void => {
      if (!chunk) {
        return;
      }
      firstCliOutputAt ??= now();
      if (stream === "stdout") {
        responseStreamBytes += Buffer.byteLength(chunk, "utf8");
      }
    },
    observeAssistantMessage: (message: unknown): void => {
      if (!capture.outputMessages) {
        return;
      }
      const normalized = normalizeClaudeAssistantMessage(message);
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
          durationMs: Math.max(0, now() - startedAt),
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
      const failureKind = failureKindForClaudeCli(error, params.context.params.abortSignal);
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          ...baseFields,
          durationMs: Math.max(0, now() - startedAt),
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
