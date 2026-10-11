import { createHash } from "node:crypto";
import { serializeModelRequestBody } from "@openclaw/ai/internal/openai";
import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ProviderPromptTask = { payload: unknown; encode: boolean };

type ProviderPromptItemFingerprint = { digest: string; fields?: Record<string, string> };

export type ProviderPromptCachePrefix = {
  system: string;
  tools: string;
  messages: ProviderPromptItemFingerprint[];
  messageField?: "input" | "messages";
  messageCount: number;
  tail?: string;
  parameters: ProviderPromptItemFingerprint;
  continuation: boolean;
};

const MAX_MESSAGE_FINGERPRINTS = 512;
const MAX_MESSAGE_FIELD_FINGERPRINTS = 32;
// Only protocol field names may survive the worker; extension keys can contain private data.
const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "type",
  "id",
  "reasoning",
  "encrypted_content",
  "summary",
  "status",
  "call_id",
  "tool_call_id",
  "tool_calls",
  "name",
  "arguments",
  "output",
  "refusal",
]);
const PARAMETER_FIELDS = new Set([
  "model",
  "input",
  "messages",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
  "store",
  "include",
  "previous_response_id",
  "truncation",
  "service_tier",
  "reasoning",
  "reasoning_effort",
  "metadata",
  "text",
  "response_format",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "user",
]);

function fingerprintItem(
  value: unknown,
  allowedFields?: Set<string>,
): ProviderPromptItemFingerprint {
  if (!allowedFields || !isRecord(value)) {
    return { digest: sha256Hex(JSON.stringify(value)), ...(allowedFields ? { fields: {} } : {}) };
  }
  const digest = createHash("sha256").update("{");
  let other: ReturnType<typeof createHash> | undefined;
  const fields: Record<string, string> = {};
  let separator = "";
  for (const [key, field] of Object.entries(value)) {
    // Serialize each field once, sharing its bytes between the item and field digests.
    const name = `${JSON.stringify(key)}:`;
    const encoded = JSON.stringify(field);
    digest.update(separator).update(name).update(encoded);
    separator = ",";
    if (allowedFields.has(key)) {
      fields[key] = sha256Hex(encoded);
    } else {
      (other ??= createHash("sha256")).update(name).update(encoded).update(",");
    }
  }
  if (other) {
    fields.other = other.digest("hex");
  }
  return { digest: digest.update("}").digest("hex"), fields };
}

function fingerprintSerializedPrompt(payload: unknown): ProviderPromptCachePrefix | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const { instructions, system, tools, ...parameters } = payload;
  let messageField: "input" | "messages" | undefined;
  let messages: unknown[] = [];
  if (Array.isArray(parameters.input)) {
    messageField = "input";
    messages = parameters.input;
    delete parameters.input;
  } else if (Array.isArray(parameters.messages)) {
    messageField = "messages";
    messages = parameters.messages;
    delete parameters.messages;
  }
  return {
    system: sha256Hex(JSON.stringify({ instructions, system })),
    tools: sha256Hex(JSON.stringify({ tools })),
    messages: messages
      .slice(0, MAX_MESSAGE_FINGERPRINTS)
      .map((message, index) =>
        fingerprintItem(
          message,
          index < MAX_MESSAGE_FIELD_FINGERPRINTS ? MESSAGE_FIELDS : undefined,
        ),
      ),
    messageField,
    messageCount: messages.length,
    ...(messages.length > MAX_MESSAGE_FINGERPRINTS
      ? { tail: sha256Hex(JSON.stringify(messages.slice(MAX_MESSAGE_FINGERPRINTS))) }
      : {}),
    parameters: fingerprintItem(parameters, PARAMETER_FIELDS),
    continuation:
      typeof parameters.previous_response_id === "string" &&
      parameters.previous_response_id.length > 0,
  };
}

export function prepareProviderPrompt({ payload, encode }: ProviderPromptTask): {
  digest: string;
  byteWeight: number;
  encoded: ReturnType<typeof serializeModelRequestBody> | undefined;
  cachePrefix?: ProviderPromptCachePrefix;
} {
  if (!encode) {
    return { ...sha256StableValue(payload), encoded: undefined };
  }
  let cachePrefix: ProviderPromptCachePrefix | undefined;
  const encoded = serializeModelRequestBody(payload, (serialized) => {
    cachePrefix = fingerprintSerializedPrompt(serialized);
  });
  return {
    digest: sha256Hex(encoded.body),
    byteWeight: encoded.body.byteLength,
    encoded,
    cachePrefix,
  };
}
