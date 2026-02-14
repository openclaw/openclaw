/**
 * Resilient fetch wrapper for Ollama that handles common failure modes
 * of local inference: cold starts, model loading, and connection issues.
 */

export interface OllamaFetchOptions {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

function isConnectionRefused(error: unknown): boolean {
  if (error instanceof TypeError && error.cause) {
    const cause = error.cause as Record<string, unknown>;
    return cause?.code === "ECONNREFUSED" || cause?.errno === "ECONNREFUSED";
  }
  if (error instanceof Error) {
    return error.message.includes("ECONNREFUSED");
  }
  return false;
}

function isTimeout(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  return false;
}

export async function ollamaFetch(
  url: string,
  init?: RequestInit,
  opts?: OllamaFetchOptions,
): Promise<Response> {
  const maxRetries = opts?.retries ?? 3;
  const baseDelay = opts?.retryDelayMs ?? 1000;
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Merge timeout signal with any existing signal
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signals: AbortSignal[] = [timeoutSignal];
      if (init?.signal) {
        signals.push(init.signal);
      }
      const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const response = await fetch(url, {
        ...init,
        signal: combinedSignal,
      });

      // 503 = model loading, retry with backoff
      if (response.status === 503 && attempt < maxRetries) {
        const err = new Error(`Ollama returned 503: model loading`);
        lastError = err;
        opts?.onRetry?.(attempt + 1, err);
        await sleep(baseDelay * Math.pow(2, attempt));
        continue;
      }

      // Other 4xx/5xx: don't retry
      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Ollama API error ${response.status}: ${text}`);
      }

      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      // Timeout: don't retry
      if (isTimeout(err)) {
        throw err;
      }

      // Non-retryable
      if (!isConnectionRefused(err) && attempt > 0) {
        throw err;
      }
      if (!isConnectionRefused(err) && attempt === 0 && !isRetryableNetworkError(err)) {
        throw err;
      }

      // Exhausted retries
      if (attempt >= maxRetries) {
        throw err;
      }

      opts?.onRetry?.(attempt + 1, err);
      await sleep(baseDelay * Math.pow(2, attempt));
    }
  }

  throw lastError ?? new Error("ollamaFetch: unexpected end of retries");
}

function isRetryableNetworkError(error: Error): boolean {
  return isConnectionRefused(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
