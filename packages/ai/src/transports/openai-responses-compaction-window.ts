import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInputItem } from "openai/resources/responses/responses.js";
import type { AiTransportHost } from "../host.js";
import { createSseByteGuard } from "../utils/streaming-byte-guard.js";
import type {
  ReplayableResponseCompactionItem,
  ReplayableResponseOutputMessage,
} from "./openai-responses-contracts.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import { sanitizeResponsesImageInput } from "./responses-image-input-sanitizer.js";

// This is the host's response/storage ceiling, not a provider context-token limit.
const COMPACTION_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export type OpenAIResponsesCompactionOutput = Array<
  ResponseInputItem.Message | ReplayableResponseOutputMessage | ReplayableResponseCompactionItem
>;
export type OpenAIResponsesCompactedWindow =
  | { state: "ready"; output: string; outputTokens?: number }
  | { state: "refresh-required" };

// Retain identity only, never parsed windows or their image data, alongside saved replay state.
const compactionInputIdentities = new WeakMap<object, object[]>();
const preparedCompactionInputs = new WeakMap<object, object>();

export function getResponsesCompactionInputIdentity(item: object): object | undefined {
  return preparedCompactionInputs.get(item);
}

export function publishResponsesCompactionInput<T extends object[]>(
  source: object,
  input: T,
  immutable?: AiTransportHost["immutableData"],
): T {
  if (!immutable?.isDeeplyFrozenPlainData(source)) {
    return input;
  }
  let identities = compactionInputIdentities.get(source);
  if (!identities) {
    identities = [];
    compactionInputIdentities.set(source, identities);
  }
  let index = 0;
  for (const item of input) {
    immutable.freezeJsonSnapshot(item);
    preparedCompactionInputs.set(item, (identities[index++] ??= {}));
  }
  return input;
}

/** Provenance is off-wire; an alias of prepared immutable input keeps its byte identity. */
export function tagResponsesCompactionInput<T extends object>(item: T, marker: symbol): T {
  const tagged = { ...item, [marker]: true };
  const identity = preparedCompactionInputs.get(item);
  if (identity) {
    Object.freeze(tagged);
    preparedCompactionInputs.set(tagged, identity);
  }
  return tagged;
}

// Schema validation, not coercion: supplied non-string fields must be rejected.
function isOptionalCompactionString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  // Optional provider metadata reaches recursive transcript redaction. Bound
  // its nesting as well as bytes before retaining an otherwise valid window.
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return (
    (Array.isArray(value) || isRecord(value)) &&
    Object.values(value).every((child) => isBoundedJson(child, depth + 1))
  );
}

function isInputContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const breakpoint = value.prompt_cache_breakpoint;
  if (breakpoint !== undefined && (!isRecord(breakpoint) || breakpoint.mode !== "explicit")) {
    return false;
  }
  switch (value.type) {
    case "input_text":
      return typeof value.text === "string";
    case "output_text":
      return typeof value.text === "string" && Array.isArray(value.annotations);
    case "input_image":
      return (
        typeof value.detail === "string" &&
        ["auto", "low", "high", "original"].includes(value.detail) &&
        (typeof value.image_url === "string" || typeof value.file_id === "string") &&
        (value.image_url === null || isOptionalCompactionString(value.image_url)) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id))
      );
    case "input_file":
      return (
        (value.detail === undefined ||
          (typeof value.detail === "string" && ["auto", "low", "high"].includes(value.detail))) &&
        [value.file_data, value.file_id, value.file_url].some(
          (entry) => typeof entry === "string",
        ) &&
        isOptionalCompactionString(value.file_data) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id)) &&
        isOptionalCompactionString(value.file_url) &&
        isOptionalCompactionString(value.filename)
      );
    default:
      return false;
  }
}

/** Validate without projecting: accepted provider fields must survive replay unchanged. */
export function isOpenAIResponsesCompactionOutput(
  value: unknown,
  model?: Model,
): value is OpenAIResponsesCompactionOutput {
  return getOpenAIResponsesCompactionOutputError(value, model) === undefined;
}

/** Return a safe rule failure, never provider content or encrypted checkpoint bytes. */
export function getOpenAIResponsesCompactionOutputError(
  value: unknown,
  model?: Model,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return "output must be a nonempty array";
  }
  if (!isBoundedJson(value)) {
    return "output must contain finite JSON values nested at most 64 levels";
  }
  const item: unknown = value.at(-1);
  if (!isRecord(item) || item.type !== "compaction") {
    return "output must end with a compaction item";
  }
  if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    return "trailing compaction item must have nonempty encrypted_content";
  }
  if (!isOptionalCompactionString(item.id) || !isOptionalCompactionString(item.created_by)) {
    return "trailing compaction item metadata must be strings";
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    const message: unknown = value[index];
    if (isRecord(message) && message.type === "compaction") {
      return "output must contain exactly one compaction item";
    }
    if (
      !isRecord(message) ||
      message.type !== "message" ||
      typeof message.role !== "string" ||
      !["user", "developer", "system", "assistant"].includes(message.role)
    ) {
      return `output item ${index} must be a user, developer, system, or assistant message`;
    }
    if (
      !isOptionalCompactionString(message.id) ||
      (message.status !== undefined &&
        (typeof message.status !== "string" ||
          !["in_progress", "completed", "incomplete"].includes(message.status)))
    ) {
      return `output message ${index} has invalid metadata`;
    }
    if (!Array.isArray(message.content) || !message.content.every(isInputContent)) {
      return `output message ${index} has unsupported content`;
    }
  }
  // Storage accepts some image formats that Responses egress would replace.
  // A canonical window must survive that existing policy without any rewrite.
  const payload = { input: sanitizeResponsesImageInput(value) };
  if (model) {
    applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(model));
  }
  if (JSON.stringify(payload.input) !== JSON.stringify(value)) {
    return "output would be rewritten by the Responses payload policy";
  }
  return undefined;
}

/** Read the saved canonical window only when it still matches its opaque checkpoint. */
export function readOpenAIResponsesCompactionWindow(
  replay: {
    data: string;
    id?: string;
    compactedWindow?: unknown;
  },
  model?: Model,
  immutable?: AiTransportHost["immutableData"],
): OpenAIResponsesCompactionOutput | undefined {
  const window = replay.compactedWindow;
  if (!isRecord(window) || window.state !== "ready" || typeof window.output !== "string") {
    return undefined;
  }
  if (
    window.outputTokens !== undefined &&
    (!Number.isSafeInteger(window.outputTokens) ||
      typeof window.outputTokens !== "number" ||
      window.outputTokens < 0)
  ) {
    return undefined;
  }
  if (
    Buffer.byteLength(window.output, "utf8") + Buffer.byteLength(replay.data, "utf8") >
    COMPACTION_WINDOW_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(replay), "utf8") > COMPACTION_WINDOW_MAX_BYTES) {
      return undefined;
    }
    const output: unknown = JSON.parse(window.output);
    if (!isOpenAIResponsesCompactionOutput(output, model)) {
      return undefined;
    }
    const item = output.at(-1);
    if (
      item?.type !== "compaction" ||
      item.encrypted_content !== replay.data ||
      item.id !== replay.id
    ) {
      return undefined;
    }
    // These IDs refer to reasoning items absorbed by the checkpoint. Replaying
    // them makes OpenAI require those missing items; keep the saved window intact
    // but emit retained assistants as inline messages, with content and phase unchanged.
    for (const message of output) {
      if (message.type === "message" && message.role === "assistant") {
        delete message.id;
      }
    }
    return publishResponsesCompactionInput(replay, output, immutable);
  } catch {
    return undefined;
  }
}

/** Bound success bytes while leaving body deadlines, retries, and parsing to the SDK. */
export function createBoundedOpenAIResponsesCompactionFetch(
  upstreamFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await upstreamFetch(input, init);
    if (!response.ok || !response.body) {
      return response;
    }
    const reader = response.body.getReader();
    const guard = createSseByteGuard(reader, {
      maxBytes: COMPACTION_WINDOW_MAX_BYTES,
      onOverflow: () => new Error("Responses compact endpoint response exceeds 16 MiB"),
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await guard.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          reader.releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        // Cancellation may never settle; it must not hold the SDK's timeout outcome.
        void guard.cancel(reason);
        reader.releaseLock();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
