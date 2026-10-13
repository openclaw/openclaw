import { serializeModelRequestBody } from "@openclaw/ai/internal/openai";
import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type ProviderPromptTask = { payload: unknown; encode: boolean };

export type ProviderPromptCachePrefix = {
  system: string;
  tools: string;
  messages: string[];
  messageCount: number;
  tail?: string;
  parameters: string;
};

const MAX_MESSAGE_FINGERPRINTS = 512;

function fingerprintEncodedPrompt(body: Uint8Array): ProviderPromptCachePrefix | undefined {
  if (body.byteLength === 0) {
    return undefined;
  }
  // Inspect serialized values so getters, toJSON, and omitted properties match egress.
  const payload: unknown = JSON.parse(new TextDecoder().decode(body));
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
      .map((message) => sha256Hex(JSON.stringify(message))),
    messageCount: messages.length,
    ...(messages.length > MAX_MESSAGE_FINGERPRINTS
      ? { tail: sha256Hex(JSON.stringify(messages.slice(MAX_MESSAGE_FINGERPRINTS))) }
      : {}),
    parameters: sha256Hex(JSON.stringify([messageField, parameters])),
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
  const encoded = serializeModelRequestBody(payload);
  return {
    digest: sha256Hex(encoded.body),
    byteWeight: encoded.body.byteLength,
    encoded,
    cachePrefix: fingerprintEncodedPrompt(encoded.body),
  };
}
