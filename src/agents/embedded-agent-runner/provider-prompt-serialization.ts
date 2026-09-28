import { serializeModelRequestBody } from "@openclaw/ai/internal/openai";
import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";

export type ProviderPromptTask = { payload: unknown; encode: boolean };

export function prepareProviderPrompt({ payload, encode }: ProviderPromptTask): {
  digest: string;
  byteWeight: number;
  encoded: ReturnType<typeof serializeModelRequestBody> | undefined;
} {
  if (!encode) {
    return { ...sha256StableValue(payload), encoded: undefined };
  }
  const encoded = serializeModelRequestBody(payload);
  return {
    digest: sha256Hex(encoded.body),
    byteWeight: encoded.body.byteLength,
    encoded,
  };
}
