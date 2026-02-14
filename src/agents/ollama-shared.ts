/** Shared constants and helpers for Ollama modules. */

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** Simple GET+JSON with timeout, returns parsed JSON or throws. */
export async function ollamaGet(url: string, timeoutMs = 3000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}
