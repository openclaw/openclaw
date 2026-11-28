import { createHash, hash } from "node:crypto";
import {
  serializeModelRequestBody,
  type EncodedModelRequestBody,
} from "@openclaw/ai/internal/model-request-body";
import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ProviderPromptTask = { payload: unknown; encode: boolean };
type ModelRequestJson = NonNullable<ReturnType<typeof serializeModelRequestBody>["json"]>;

type ProviderPromptItemFingerprint = { digest: string; fields: Record<string, string> };

export type ProviderPromptCachePrefix = {
  system: string;
  tools: string;
  messageDigests: string;
  messageFields: Record<string, string>[];
  messageField?: "input" | "messages" | "contents";
  messageCount: number;
  tail?: string;
  parameters: ProviderPromptItemFingerprint;
  continuation: boolean;
};

const MAX_MESSAGE_FINGERPRINTS = 512;
const MAX_MESSAGE_FIELD_FINGERPRINTS = 32;
const WIRE_PREFIX_BYTES = 4096;
// Only protocol field names may survive the worker; extension keys can contain private data.
const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "parts",
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
  "contents",
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
  "cachedContent",
  "generationConfig",
  "toolConfig",
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

function fingerprintGenerationConfig(
  field: ModelRequestJson,
  fields: Record<string, string>,
): void {
  if (field.json[0] !== "{") {
    fields.generationConfig = sha256Hex(field.json);
    return;
  }
  let withoutOutputCap: ReturnType<typeof createHash> | undefined;
  let separator = "";
  for (const [subKey, subField] of field.members()) {
    if (subKey === "maxOutputTokens") {
      fields["generationConfig.maxOutputTokens"] = sha256Hex(subField.json);
      continue;
    }
    withoutOutputCap ??= createHash("sha256").update("{");
    withoutOutputCap
      .update(separator)
      .update(`${JSON.stringify(subKey)}:`)
      .update(subField.json);
    separator = ",";
  }
  if (withoutOutputCap) {
    fields.generationConfig = withoutOutputCap.update("}").digest("hex");
  }
}

function fingerprintFields(
  members: Iterable<[string, ModelRequestJson]>,
  allowedFields: Set<string>,
  splitGenerationConfig = false,
): ProviderPromptItemFingerprint {
  const digest = createHash("sha256").update("{");
  let other: ReturnType<typeof createHash> | undefined;
  const fields: Record<string, string> = {};
  let separator = "";
  for (const [key, field] of members) {
    const name = `${JSON.stringify(key)}:`;
    digest.update(separator).update(name).update(field.json);
    separator = ",";
    if (splitGenerationConfig && key === "generationConfig") {
      fingerprintGenerationConfig(field, fields);
    } else if (allowedFields.has(key)) {
      fields[key] = sha256Hex(field.json);
    } else {
      (other ??= createHash("sha256")).update(name).update(field.json).update(",");
    }
  }
  if (other) {
    fields.other = other.digest("hex");
  }
  return { digest: digest.update("}").digest("latin1"), fields };
}

function fingerprintSerializedPrompt(
  payload: ModelRequestJson | undefined,
): ProviderPromptCachePrefix | undefined {
  if (payload?.json[0] !== "{") {
    return undefined;
  }
  const parameters = new Map(payload.members());
  const system = createHash("sha256").update("{");
  let separator = "";
  for (const key of ["instructions", "system", "systemInstruction"]) {
    const field = parameters.get(key);
    parameters.delete(key);
    if (field) {
      system
        .update(separator)
        .update(`${JSON.stringify(key)}:`)
        .update(field.json);
      separator = ",";
    }
  }
  const tools = parameters.get("tools");
  parameters.delete("tools");
  let messageField: "input" | "messages" | "contents" | undefined;
  if (parameters.get("input")?.json[0] === "[") {
    messageField = "input";
  } else if (parameters.get("messages")?.json[0] === "[") {
    messageField = "messages";
  } else if (parameters.get("contents")?.json[0] === "[") {
    messageField = "contents";
  }
  const messages = messageField ? parameters.get(messageField) : undefined;
  if (messageField) {
    parameters.delete(messageField);
  }
  const messageFields: Record<string, string>[] = [];
  let messageDigests = "";
  let messageCount = 0;
  let tail: ReturnType<typeof createHash> | undefined;
  for (const [, message] of messages?.members() ?? []) {
    const index = messageCount++;
    if (index >= MAX_MESSAGE_FINGERPRINTS) {
      if (tail) {
        tail.update(",");
      } else {
        tail = createHash("sha256").update("[");
      }
      tail.update(message.json);
    } else if (index >= MAX_MESSAGE_FIELD_FINGERPRINTS || message.json[0] !== "{") {
      messageDigests += hash("sha256", message.json, "latin1");
      if (index < MAX_MESSAGE_FIELD_FINGERPRINTS) {
        messageFields.push({});
      }
    } else {
      const fingerprint = fingerprintFields(message.members(), MESSAGE_FIELDS);
      messageFields.push(fingerprint.fields);
      messageDigests += fingerprint.digest;
    }
  }
  const previousResponse = parameters.get("previous_response_id")?.json;
  return {
    system: system.update("}").digest("hex"),
    tools: tools
      ? createHash("sha256").update('{"tools":').update(tools.json).update("}").digest("hex")
      : sha256Hex("{}"),
    messageDigests,
    messageFields,
    messageField,
    messageCount,
    ...(tail ? { tail: tail.update("]").digest("hex") } : {}),
    parameters: fingerprintFields(parameters, PARAMETER_FIELDS, true),
    continuation: previousResponse?.[0] === '"' && previousResponse !== '""',
  };
}

export function prepareProviderPrompt({ payload, encode }: ProviderPromptTask): {
  digest: string;
  byteWeight: number;
  encoded: EncodedModelRequestBody | undefined;
  cachePrefix?: ProviderPromptCachePrefix;
  wire?: {
    requestBytes: number;
    prefixBytes: number;
    prefixHash: string;
    cacheKeyPresent: boolean;
    cacheKeyHash?: string;
    previousResponseIdPresent: boolean;
    modelHash?: string;
    serviceTier?: string;
  };
} {
  if (!encode) {
    return { ...sha256StableValue(payload), encoded: undefined };
  }
  const { json, ...encoded } = serializeModelRequestBody(payload);
  const cachePrefix = fingerprintSerializedPrompt(json);
  return {
    digest: sha256Hex(encoded.body),
    byteWeight: encoded.body.byteLength,
    encoded,
    cachePrefix,
    wire: {
      requestBytes: encoded.body.byteLength,
      prefixBytes: Math.min(encoded.body.byteLength, WIRE_PREFIX_BYTES),
      prefixHash: createHash("sha256")
        .update(encoded.body.subarray(0, WIRE_PREFIX_BYTES))
        .digest("hex"),
      cacheKeyPresent: cachePrefix?.parameters.fields?.prompt_cache_key !== undefined,
      cacheKeyHash: cachePrefix?.parameters.fields?.prompt_cache_key?.slice(0, 16),
      previousResponseIdPresent: cachePrefix?.continuation ?? false,
      modelHash: cachePrefix?.parameters.fields?.model?.slice(0, 16),
      serviceTier:
        isRecord(payload) && typeof payload.service_tier === "string"
          ? payload.service_tier
          : undefined,
    },
  };
}
