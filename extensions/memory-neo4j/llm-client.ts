/**
 * OpenRouter/OpenAI-compatible LLM API client for memory-neo4j.
 *
 * Handles non-streaming and streaming chat completion requests with
 * retry logic, timeout handling, and abort signal support.
 */

import type { ExtractionConfig } from "./config.js";

// Timeout for LLM and embedding fetch calls to prevent hanging indefinitely
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Build a combined abort signal from the caller's signal and a per-request timeout.
 */
function buildSignal(abortSignal?: AbortSignal): AbortSignal {
  return abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

/**
 * Shared request/retry logic for OpenRouter API calls.
 * Handles signal composition, request building, error handling, and exponential backoff.
 * The `parseFn` callback processes the Response differently for streaming vs non-streaming.
 */
async function openRouterRequest(
  config: ExtractionConfig,
  messages: Array<{ role: string; content: string }>,
  abortSignal: AbortSignal | undefined,
  stream: boolean,
  parseFn: (response: Response, abortSignal?: AbortSignal) => Promise<string | null>,
): Promise<string | null> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const signal = buildSignal(abortSignal);

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature,
          response_format: { type: "json_object" },
          ...(stream ? { stream: true } : {}),
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }

      return await parseFn(response, abortSignal);
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  return null;
}

/**
 * Parse a non-streaming JSON response.
 */
function parseNonStreaming(response: Response): Promise<string | null> {
  return response.json().then((data: unknown) => {
    const typed = data as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return typed.choices?.[0]?.message?.content ?? null;
  });
}

/**
 * Parse a streaming SSE response, accumulating chunks into a single string.
 */
async function parseStreaming(
  response: Response,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (!response.body) {
    throw new Error("No response body for streaming request");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  for (;;) {
    // Check abort between chunks for responsive cancellation
    if (abortSignal?.aborted) {
      reader.cancel().catch(() => {});
      return null;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) {
          accumulated += chunk;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return accumulated || null;
}

export async function callOpenRouter(
  config: ExtractionConfig,
  prompt: string | Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  return openRouterRequest(config, messages, abortSignal, false, parseNonStreaming);
}

/**
 * Streaming variant of callOpenRouter. Uses the streaming API to receive chunks
 * incrementally, allowing earlier cancellation via abort signal and better
 * latency characteristics for long responses.
 *
 * Accumulates all chunks into a single response string since extraction
 * uses JSON mode (which requires the complete object to parse).
 */
export async function callOpenRouterStream(
  config: ExtractionConfig,
  prompt: string | Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  return openRouterRequest(config, messages, abortSignal, true, parseStreaming);
}

/**
 * Check if an error is transient (network/timeout) vs permanent (JSON parse, etc.)
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("api error 429") ||
    msg.includes("api error 502") ||
    msg.includes("api error 503") ||
    msg.includes("api error 504")
  );
}
