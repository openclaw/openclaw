import { parseJsonPreservingUnsafeIntegers } from "openclaw/plugin-sdk/json-unsafe-integers";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OllamaToolCall } from "./stream-messages.js";
import { checkNdjsonRecordCap } from "./stream-ndjson-cap.js";

export interface OllamaChatResponse extends Record<string, unknown> {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    thinking?: string;
    reasoning?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export async function* readOllamaNdjsonLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: {
    decoder?: TextDecoder;
    read?: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  } = {},
): AsyncGenerator<string> {
  const decoder = options.decoder ?? new TextDecoder("utf-8", { fatal: true });
  const read = options.read ?? (() => reader.read());
  let buffer = "";
  let pendingRecordBytes = 0;
  try {
    while (true) {
      const { done, value } = await read();
      if (done) {
        break;
      }
      pendingRecordBytes = checkNdjsonRecordCap(value, pendingRecordBytes);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        yield trimmed;
      }
    }

    // Chat rejects incomplete UTF-8; pull keeps its tolerant trailing-byte behavior.
    if (decoder.fatal) {
      buffer += decoder.decode();
    }
    if (buffer.trim()) {
      yield buffer.trim();
    }
  } finally {
    // Start cancellation best-effort; do not await it — a pending cancel
    // must not stall releaseLock() and keep the reader locked.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
  for await (const line of readOllamaNdjsonLines(reader)) {
    yield parseOllamaNdjsonRecord(line);
  }
}

function parseOllamaNdjsonRecord(value: string): OllamaChatResponse {
  let parsed: unknown;
  try {
    parsed = parseJsonPreservingUnsafeIntegers(value);
  } catch {
    throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  }
  if (!isRecord(parsed)) {
    throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  }
  if (typeof parsed.error === "string") {
    const status =
      typeof parsed.status === "number" && Number.isFinite(parsed.status)
        ? parsed.status
        : undefined;
    throw Object.assign(
      new Error(status === undefined ? parsed.error : `${status}: ${parsed.error}`),
      {
        ...(status === undefined ? {} : { status }),
        body: parsed,
      },
    );
  }
  if (!isRecord(parsed.message) || typeof parsed.done !== "boolean") {
    throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  }
  // SAFETY: Required Ollama chat-record fields are validated above; optional fields remain inert.
  return parsed as OllamaChatResponse;
}
