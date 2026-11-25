import type { Model, ModelRequestHeaders } from "@openclaw/llm-core";
import { consumeResponseBytes } from "@openclaw/normalization-core";
import { raceWithTimeout } from "../../../retry/src/index.js";
import { getAiTransportHost } from "../host.js";
export { redactIdentifier, sha256Hex } from "@openclaw/normalization-core/node-crypto";
export { createAbortError } from "../../../retry/src/index.js";
export { parseRetryAfterHeadersSeconds as parseRetryAfterSeconds } from "../internal/retry-after.js";
export { parsePositiveInteger } from "./positive-integer.js";

export const MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE =
  "OpenClaw transport error: malformed_streaming_fragment";

/** Keep provider payloads out of parse errors without replacing unrelated failures. */
export function streamFragmentError(
  cause: unknown,
  ErrorType: new (message: string, options: { cause: SyntaxError }) => Error = Error,
): unknown {
  return cause instanceof SyntaxError
    ? new ErrorType(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause })
    : cause;
}

export function resolveModelHeaderSentinels<TModel extends Model>(model: TModel): TModel {
  if (!model.headers) {
    return model;
  }
  let headers: ModelRequestHeaders | undefined;
  for (const [name, value] of Object.entries(model.headers)) {
    if (value === null) {
      continue;
    }
    const resolved = getAiTransportHost().resolveSecretSentinel(value);
    if (resolved !== value) {
      headers ??= { ...model.headers };
      headers[name] = resolved;
    }
  }
  return headers ? ({ ...model, headers } as TModel) : model;
}

export function supportsModelTools(model: { compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  return compat?.supportsTools !== false;
}

export function isCodeModeModelVisibleToolName(
  name: string,
  visibleToolNames: ReadonlySet<string>,
): boolean {
  return visibleToolNames.has(name);
}

const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;

export async function readAnthropicMessagesErrorSnippet(
  response: Response,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    const result = await consumeResponseBytes({
      maxBytes: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
      stopAtLimit: true,
      read: () =>
        raceWithTimeout(reader.read(), ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS, () => {
          throw new Error(
            `Anthropic Messages error response stalled: no data received for ${ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS}ms`,
          );
        }),
      onChunk: (chunk) => chunks.push(chunk),
      onLimit: () => {
        // Capture tees must not delay the byte limit or timeout outcome.
        void reader.cancel().catch(() => undefined);
      },
    });
    bytes = Math.min(result.size, ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES);
    truncated = result.truncated;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const collapsed = new TextDecoder().decode(merged).replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  return truncated ? `${collapsed}…` : collapsed;
}
