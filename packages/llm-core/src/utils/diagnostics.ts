import { Guard } from "typebox/guard";
import type { AssistantMessage } from "../types.js";

/** Provider-authored findings; continuation is offered only after explicit user review. */
export type ProviderRefusalReview = {
  explanation: string;
  continuation?: { message: string };
  errorType?: string;
};

const encoder = new TextEncoder();

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxBytes &&
    value.trim().length > 0 &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

/** Keep exact provider text. Truncation must never make an invalid continuation usable. */
export function readProviderRefusalReview(value: unknown): ProviderRefusalReview | undefined {
  if (!Guard.IsObjectNotArray(value) || !isBoundedText(value.explanation, 64 * 1024)) {
    return undefined;
  }
  const continuation = Guard.IsObjectNotArray(value.continuation)
    ? value.continuation.message
    : undefined;
  return {
    explanation: value.explanation,
    ...(isBoundedText(continuation, 1024) ? { continuation: { message: continuation } } : {}),
    ...(typeof value.errorType === "string" && value.errorType.trim()
      ? { errorType: value.errorType }
      : {}),
  };
}

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: Record<string, unknown>;
}

/** True when the provider explicitly refused the request payload. */
export function isProviderRefusalAssistantError(
  message: { diagnostics?: AssistantMessageDiagnostic[] } | null | undefined,
): boolean {
  return Boolean(
    message?.diagnostics?.some((diagnostic) => diagnostic.type === "provider_refusal"),
  );
}

/** Formats arbitrary thrown values into diagnostic-safe text. */
export function formatThrownValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/** Extracts serializable diagnostic error fields from Error and non-Error throws. */
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) {
    return { name: "ThrownValue", message: formatThrownValue(error) };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

/** Creates a timestamped assistant-message diagnostic entry. */
export function createAssistantMessageDiagnostic(
  type: string,
  error: unknown,
  details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
  return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

/** Appends a diagnostic while preserving existing message diagnostics. */
export function appendAssistantMessageDiagnostic(
  message: { diagnostics?: AssistantMessageDiagnostic[] },
  diagnostic: AssistantMessageDiagnostic,
): void {
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
/** Records only the presence of hidden reasoning; never copies its content. */
export function recordSuppressedReasoning(message: AssistantMessage): Error | undefined {
  if (!message.diagnostics?.some((entry) => entry.type === "reasoning_suppressed")) {
    appendAssistantMessageDiagnostic(message, {
      type: "reasoning_suppressed",
      timestamp: Date.now(),
    });
  }
  if (
    (message.stopReason !== "stop" && message.stopReason !== "length") ||
    message.content.some(
      (block) => block.type === "toolCall" || (block.type === "text" && block.text.trim()),
    )
  ) {
    return undefined;
  }
  return new Error(
    `${message.provider}/${message.model} returned only reasoning while configured reasoning: false. ` +
      `Set reasoning: true for this model in models.providers.${message.provider}.models or choose a non-thinking model.` +
      (message.stopReason === "length"
        ? " The output token limit was reached before an answer."
        : ""),
  );
}
