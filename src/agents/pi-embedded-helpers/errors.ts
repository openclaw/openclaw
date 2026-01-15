import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { ClawdbotConfig } from "../../config/config.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox.js";
import type { FailoverReason } from "./types.js";

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("context overflow") ||
    (lower.includes("413") && lower.includes("too large"))
  );
}

export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (!isContextOverflowError(errorMessage)) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction")
  );
}

const ERROR_PAYLOAD_PREFIX_RE =
  /^(?:error|api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error)[:\s-]+/i;

type ErrorPayload = Record<string, unknown>;

function isErrorPayloadObject(payload: unknown): payload is ErrorPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as ErrorPayload;
  if (record.type === "error") return true;
  if (typeof record.request_id === "string" || typeof record.requestId === "string") return true;
  if ("error" in record) {
    const err = record.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const errRecord = err as ErrorPayload;
      if (
        typeof errRecord.message === "string" ||
        typeof errRecord.type === "string" ||
        typeof errRecord.code === "string"
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseApiErrorPayload(raw: string): ErrorPayload | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  if (ERROR_PAYLOAD_PREFIX_RE.test(trimmed)) {
    candidates.push(trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim());
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isErrorPayloadObject(parsed)) return parsed;
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function getApiErrorPayloadFingerprint(raw?: string): string | null {
  if (!raw) return null;
  const payload = parseApiErrorPayload(raw);
  if (!payload) return null;
  return stableStringify(payload);
}

export function isRawApiErrorPayload(raw?: string): boolean {
  return getApiErrorPayloadFingerprint(raw) !== null;
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: { cfg?: ClawdbotConfig; sessionKey?: string },
): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) return rewritten;
  }

  if (isContextOverflowError(raw)) {
    return (
      "Context overflow: prompt too large for the model. " +
      "Try again with less input or a larger-context model."
    );
  }

  if (/incorrect role information|roles must alternate/i.test(raw)) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  if (isOverloadedErrorMessage(raw)) {
    return "The AI service is temporarily overloaded. Please try again in a moment.";
  }

  if (isRawApiErrorPayload(raw)) {
    return "The AI service returned an error. Please try again.";
  }

  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function isRateLimitAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isRateLimitErrorMessage(msg.errorMessage ?? "");
}

type ErrorPattern = RegExp | string;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "usage limit",
  ],
  overloaded: [/overloaded_error|"type"\s*:\s*"overloaded_error"/i, "overloaded"],
  timeout: ["timeout", "timed out", "deadline exceeded", "context deadline exceeded"],
  billing: [
    /\b402\b/,
    "payment required",
    "insufficient credits",
    "credit balance",
    "plans & billing",
  ],
  auth: [
    /invalid[_ ]?api[_ ]?key/,
    "incorrect api key",
    "invalid token",
    "authentication",
    "unauthorized",
    "forbidden",
    "access denied",
    "expired",
    "token has expired",
    /\b401\b/,
    /\b403\b/,
    "no credentials found",
    "no api key found",
  ],
  format: [
    "invalid_request_error",
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
  ],
} as const;

function matchesErrorPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

export function isBillingErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) return false;
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
  return (
    value.includes("billing") &&
    (value.includes("upgrade") ||
      value.includes("credits") ||
      value.includes("payment") ||
      value.includes("plan"))
  );
}

export function isBillingAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isBillingErrorMessage(msg.errorMessage ?? "");
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}

export function isOverloadedErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}

export function isCloudCodeAssistFormatError(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}

export function isAuthAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

export function classifyFailoverReason(raw: string): FailoverReason | null {
  if (isRateLimitErrorMessage(raw)) return "rate_limit";
  if (isOverloadedErrorMessage(raw)) return "rate_limit";
  if (isCloudCodeAssistFormatError(raw)) return "format";
  if (isBillingErrorMessage(raw)) return "billing";
  if (isTimeoutErrorMessage(raw)) return "timeout";
  if (isAuthErrorMessage(raw)) return "auth";
  return null;
}

export function isFailoverErrorMessage(raw: string): boolean {
  return classifyFailoverReason(raw) !== null;
}

export function isFailoverAssistantError(msg: AssistantMessage | undefined): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isFailoverErrorMessage(msg.errorMessage ?? "");
}
