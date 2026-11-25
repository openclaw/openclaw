import { Buffer } from "node:buffer";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadItem, type JsonObject, type JsonValue } from "./protocol.js";

const BIO_POLICY_SAFETY_ACCESS_BLOCK_PREFIX =
  "This content was flagged for possible biological risk.";

export type CodexProviderRefusal = {
  category: "bio" | "cyber" | "misalignment";
  message: string;
  review?: ReturnType<typeof readCodexMisalignmentReview>;
  nativeThreadId?: string;
  nativeTurnId?: string;
};

/** Decode app-server v2 findings with the Codex UI's UTF-8 limits; never truncate a steer. */
function readCodexMisalignmentReview(value: unknown) {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const explanation = value.detailedExplanation;
  if (
    typeof explanation !== "string" ||
    !explanation.trim() ||
    Buffer.byteLength(explanation, "utf8") > 64 * 1024
  ) {
    return undefined;
  }
  const message = isJsonObject(value.steer) ? value.steer.message : undefined;
  return {
    explanation,
    ...(typeof message === "string" && message.trim() && Buffer.byteLength(message, "utf8") <= 1024
      ? { continuation: { message } }
      : {}),
    ...(typeof value.errorType === "string" && value.errorType.trim()
      ? { errorType: value.errorType }
      : {}),
  };
}

/** Project only Codex's explicit refusal contracts; other policy errors retain their own paths. */
export function readCodexProviderRefusal(
  message: string | undefined,
  codexErrorInfo: JsonValue | null | undefined,
  options?: {
    misalignment?: unknown;
    nativeThreadId?: string;
    nativeTurnId?: string;
  },
): CodexProviderRefusal | undefined {
  if (!message) {
    return undefined;
  }
  if (codexErrorInfo === "cyberPolicy") {
    return { category: "cyber", message };
  }
  if (codexErrorInfo === "misalignmentPolicyViolation") {
    const review = readCodexMisalignmentReview(options?.misalignment);
    return {
      category: "misalignment",
      message,
      ...(review ? { review } : {}),
      ...(options?.nativeThreadId ? { nativeThreadId: options.nativeThreadId } : {}),
      ...(options?.nativeTurnId ? { nativeTurnId: options.nativeTurnId } : {}),
    };
  }
  return message.startsWith(BIO_POLICY_SAFETY_ACCESS_BLOCK_PREFIX)
    ? { category: "bio", message }
    : undefined;
}

function codexProviderRefusalDetails(refusal: CodexProviderRefusal) {
  return {
    provider: "openai",
    category: refusal.category,
    ...(refusal.review ? { review: refusal.review } : {}),
    ...(refusal.nativeThreadId ? { nativeThreadId: refusal.nativeThreadId } : {}),
    ...(refusal.nativeTurnId ? { nativeTurnId: refusal.nativeTurnId } : {}),
  };
}

export function codexProviderRefusalDiagnostics(
  refusal: CodexProviderRefusal | undefined,
  timestamp: number,
): Pick<AssistantMessage, "diagnostics"> {
  return refusal
    ? {
        diagnostics: [
          { type: "provider_refusal", timestamp, details: codexProviderRefusalDetails(refusal) },
        ],
      }
    : {};
}

export function readNullableString(record: JsonObject, key: string): string | null | undefined {
  const value = record[key];
  return value === null || typeof value === "string" ? value : undefined;
}

export function readCodexErrorNotificationMessage(record: JsonObject): string | undefined {
  const error = record.error;
  return isJsonObject(error) ? readStringField(error, "message") : undefined;
}

export function readHookOutputEntries(
  value: JsonValue | undefined,
): Array<{ kind?: string; text: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const text = readStringField(entry, "text");
    if (!text) {
      return [];
    }
    const kind = readStringField(entry, "kind");
    return [{ ...(kind ? { kind } : {}), text }];
  });
}

export function extractRawResponseItemText(
  item: JsonObject,
  textType: "input_text" | "output_text" = "output_text",
): string | undefined {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const type = readStringField(entry, "type");
    if (type !== textType && type !== "text") {
      return [];
    }
    const value = readStringField(entry, "text");
    return value === undefined ? [] : [value];
  });
  return parts.length > 0 ? parts.join("").trim() : undefined;
}

export function readItem(value: JsonValue | undefined): CodexThreadItem | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  if (!type || !id) {
    return undefined;
  }
  return value as CodexThreadItem;
}
