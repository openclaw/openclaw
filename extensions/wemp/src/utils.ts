/** Safely coerce unknown to a record. */
export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Fetch with timeout + retry. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 1,
  timeoutMs = 6000,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (i >= retries) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("unknown fetch error");
}
