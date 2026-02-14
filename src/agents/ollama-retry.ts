/** Resilient fetch wrapper for Ollama — handles cold starts, model loading, connection issues. */

export interface OllamaFetchOptions {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

function isConnectionRefused(err: unknown): boolean {
  if (err instanceof TypeError && err.cause) {
    return (err.cause as any)?.code === "ECONNREFUSED";
  }
  return err instanceof Error && err.message.includes("ECONNREFUSED");
}

function isTimeout(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "TimeoutError" || err.name === "AbortError";
  return err instanceof Error && err.name === "TimeoutError";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;

      const response = await fetch(url, { ...init, signal });

      if (response.status === 503 && attempt < maxRetries) {
        const err = new Error("Ollama returned 503: model loading");
        lastError = err;
        opts?.onRetry?.(attempt + 1, err);
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        throw new Error(`Ollama API error ${response.status}: ${text}`);
      }

      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      if (isTimeout(err) || !isConnectionRefused(err) || attempt >= maxRetries) throw err;

      opts?.onRetry?.(attempt + 1, err);
      await sleep(baseDelay * 2 ** attempt);
    }
  }

  throw lastError ?? new Error("ollamaFetch: unexpected end of retries");
}
