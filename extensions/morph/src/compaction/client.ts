import { serializeForMorph } from "./serialize.js";
import type { MorphCompactConfig, MorphCompactResponse } from "./types.js";

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Summarize messages using the Morph compaction API.
 *
 * Returns the compressed summary string.
 * Retries on 429/503 with exponential backoff.
 * Throws on unrecoverable errors (caller handles fallback).
 */
export async function summarizeWithMorph(params: {
  messages: unknown[];
  config: MorphCompactConfig;
  signal?: AbortSignal;
}): Promise<string> {
  const { messages, config, signal } = params;
  const morphMessages = serializeForMorph(messages);

  if (morphMessages.length === 0) {
    return "No prior history.";
  }

  // Extract the latest user message as the query for relevance-based pruning.
  // The Morph API uses query to score line relevance — explicit queries give
  // tighter, more relevant compression than auto-detection.
  const lastUserMsg = [...morphMessages].reverse().find((m) => m.role === "user");
  const query = lastUserMsg?.content?.slice(0, 500);

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/compact`;
  const body = JSON.stringify({
    model: config.model,
    messages: morphMessages,
    query,
    compression_ratio: config.compressionRatio,
    preserve_recent: 0,
    include_line_ranges: true,
    include_markers: true,
  });

  const errors: Error[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Morph compaction aborted", "AbortError");
    }

    const timeoutSignal = AbortSignal.timeout(config.timeout);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

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
        return data.output;
      }

      if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfterMs = parseRetryAfterMs(response.headers);
        const backoffMs =
          retryAfterMs ?? Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
        await sleep(backoffMs, signal);
        continue;
      }

      // Non-retryable error — fail immediately, do not retry
      const errorBody = await response.text().catch(() => "");
      const errorMsg = `Morph compaction failed with HTTP ${response.status}: ${errorBody}`.slice(
        0,
        500,
      );
      errors.push(new Error(errorMsg));
      break;
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
        await sleep(backoffMs, signal);
        continue;
      }
    }
  }

  throw new Error(
    `Morph compaction failed after ${errors.length} attempt${errors.length === 1 ? "" : "s"}: ${errors.map((e) => e.message).join("; ")}`,
  );
}
