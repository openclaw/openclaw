/**
 * Model fallback wrapper.
 * Adapted from OpenClaw src/agents/model-fallback.ts
 *
 * Wraps any model call with automatic failover to the next candidate.
 */

import type { ModelRef } from "../types.js";

export interface FallbackAttempt {
  provider: string;
  model: string;
  error: Error;
  durationMs: number;
}

export interface FallbackResult<T> {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}

/**
 * Classify whether an error should trigger fallback to the next model.
 */
export function shouldFallback(error: Error): boolean {
  const msg = error.message.toLowerCase();

  // Rate limit — try next model
  if (msg.includes("rate limit") || msg.includes("429")) {
    return true;
  }

  // Auth failure — try next model
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")) {
    return true;
  }

  // Timeout — try next model
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnreset")) {
    return true;
  }

  // Model not available (Ollama model not loaded)
  if (msg.includes("model not found") || msg.includes("not available")) {
    return true;
  }

  // Context overflow — next model might have bigger window
  if (msg.includes("context") && msg.includes("exceed")) {
    return true;
  }

  // Server error — transient
  if (msg.includes("500") || msg.includes("502") || msg.includes("503")) {
    return true;
  }

  return false;
}

/**
 * Run a function with automatic model fallback.
 *
 * Tries the primary model first, then each fallback in order.
 * Only falls back on classified retryable errors.
 */
export async function runWithModelFallback<T>(params: {
  primary: ModelRef;
  fallbacks: ModelRef[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: FallbackAttempt) => void | Promise<void>;
}): Promise<FallbackResult<T>> {
  const candidates = [params.primary, ...params.fallbacks];
  const attempts: FallbackAttempt[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const start = Date.now();

    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempt: FallbackAttempt = {
        provider: candidate.provider,
        model: candidate.model,
        error,
        durationMs: Date.now() - start,
      };
      attempts.push(attempt);
      await params.onError?.(attempt);

      // Last candidate — no more fallbacks, throw
      if (i === candidates.length - 1) {
        throw new Error(
          `All model candidates failed. Attempts:\n${attempts
            .map((a) => `  ${a.provider}/${a.model}: ${a.error.message}`)
            .join("\n")}`,
        );
      }

      // Only fallback on classified errors
      if (!shouldFallback(error)) {
        throw error;
      }
    }
  }

  // Unreachable
  throw new Error("No model candidates");
}
