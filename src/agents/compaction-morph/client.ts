import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sleep } from "../../utils.js";
import { serializeForMorph } from "./serialize.js";
import type { MorphCompactConfig, MorphCompactResponse } from "./types.js";

const log = createSubsystemLogger("compaction-morph");

const MAX_ATTEMPTS = 4;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;

/** HTTP status codes that warrant a retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Extract a Retry-After delay from response headers (seconds or HTTP-date).
 * Returns milliseconds, or undefined if the header is missing/unparseable.
 */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  // Try HTTP-date format
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : undefined;
  }
  return undefined;
}

/**
 * Summarize agent messages using the Morph compaction API.
 *
 * Returns the compressed summary string (same interface as `summarizeInStages`).
 * Retries on 429/503 with exponential backoff.
 * Throws on unrecoverable errors (caller handles fallback).
 */
export async function summarizeWithMorph(params: {
  messages: AgentMessage[];
  config: MorphCompactConfig;
  signal: AbortSignal;
}): Promise<string> {
  const { messages, config, signal } = params;
  const morphMessages = serializeForMorph(messages);

  if (morphMessages.length === 0) {
    return "No prior history.";
  }

  const url = `${config.apiUrl}/v1/compact`;
  const body = JSON.stringify({
    model: config.model,
    messages: morphMessages,
    compression_ratio: config.compressionRatio,
    preserve_recent: 0,
    include_line_ranges: true,
    include_markers: true,
  });

  const errors: Error[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Check abort before each attempt (covers race between retry iterations)
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Morph compaction aborted", "AbortError");
    }

    // AbortSignal.any() correctly handles already-aborted signals
    // and avoids the event listener race conditions of manual combining.
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeout)]);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: combinedSignal,
      });

      if (response.ok) {
        const data = (await response.json()) as MorphCompactResponse;
        if (typeof data.output !== "string" || !data.output.trim()) {
          throw new Error("Morph compaction returned empty or missing output");
        }
        log.info(
          `Morph compaction complete: ${data.usage?.input_tokens ?? "?"} input → ${data.usage?.output_tokens ?? "?"} output tokens ` +
            `(${data.usage?.compression_ratio !== undefined ? (data.usage.compression_ratio * 100).toFixed(1) : "?"}% ratio, ${data.usage?.processing_time_ms ?? "?"}ms)`,
        );
        return data.output;
      }

      if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfterMs = parseRetryAfterMs(response.headers);
        const backoffMs =
          retryAfterMs ?? Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        log.warn(
          `Morph compaction received ${response.status}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await sleep(backoffMs);
        continue;
      }

      // Non-retryable error
      const errorBody = await response.text().catch(() => "");
      const errorMsg = `Morph compaction failed with HTTP ${response.status}: ${errorBody}`.slice(
        0,
        500,
      );
      throw new Error(errorMsg);
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);

      if (attempt < MAX_ATTEMPTS - 1) {
        const backoffMs = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        log.warn(
          `Morph compaction error (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${error.message}; retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }
    }
  }

  throw new Error(
    `Morph compaction failed after ${MAX_ATTEMPTS} attempts: ${errors.map((e) => e.message).join("; ")}`,
  );
}
