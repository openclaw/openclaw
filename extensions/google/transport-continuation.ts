import { createHash } from "node:crypto";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import type { GoogleStreamChunk } from "openclaw/plugin-sdk/provider-transport-runtime";
import type { GoogleContinuationOptions } from "./transport-stream-types.js";

const REPLAY_TYPE = "google.generate_content.continuation";
const MAX_TOKEN_BYTES = 16 * 1024;

function isToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_TOKEN_BYTES
  );
}

export function prepareGoogleContinuation(params: {
  model: Model;
  url: string;
  headers: Record<string, string>;
  requestBody: string;
  options?: GoogleContinuationOptions;
}) {
  const { model, options } = params;
  // Attribution request IDs change per hop; every authority-bearing header stays bound.
  const headers = Object.entries(params.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => name !== "x-request-id")
    .sort(([left], [right]) => left.localeCompare(right));
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        model.provider,
        model.api,
        model.id,
        params.url,
        options?.sessionId ?? null,
        options?.authProfileId ?? null,
        headers,
        params.requestBody,
      ]),
    )
    .digest("hex");
  const receipt = options?.googleContinuation;
  if (
    receipt !== undefined &&
    (receipt.v !== 1 ||
      receipt.type !== REPLAY_TYPE ||
      receipt.provider !== model.provider ||
      receipt.api !== model.api ||
      receipt.model !== model.id ||
      receipt.data !== binding ||
      !isToken(receipt.id))
  ) {
    throw new Error(
      "Google continuation does not match the original request and caller credential",
    );
  }
  return {
    token: receipt?.id,
    async *observe(chunks: AsyncIterable<GoogleStreamChunk>, output: AssistantMessage) {
      let token: string | undefined;
      let invalid = false;
      for await (const chunk of chunks) {
        if ((chunk.candidates?.length ?? 0) > 8) {
          invalid = true;
        }
        const candidate = chunk.candidates?.[0];
        if (candidate?.continuationToken !== undefined) {
          if (
            candidate.finishReason !== "CONTINUATION" ||
            !isToken(candidate.continuationToken) ||
            (token !== undefined && token !== candidate.continuationToken)
          ) {
            invalid = true;
          } else {
            token = candidate.continuationToken;
          }
        }
        if (
          candidate?.finishReason &&
          candidate.finishReason !== "CONTINUATION" &&
          candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
        ) {
          invalid = true;
        }
        yield chunk;
      }
      // The proxy acknowledges original-grant ownership only at HTTP EOF. This receipt
      // prevents accidental cross-context replay; the Worker still authorizes every hop.
      if (token && !invalid && output.stopReason === "length") {
        output.providerReplay = {
          v: 1,
          type: REPLAY_TYPE,
          id: token,
          data: binding,
          provider: model.provider,
          api: model.api,
          model: model.id,
        };
      }
    },
  };
}
