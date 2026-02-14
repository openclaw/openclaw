import { OLLAMA_BASE_URL } from "./ollama-shared.js";

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  error?: string;
}

export interface PullResult {
  success: boolean;
  error?: string;
}

export interface PullOptions {
  baseUrl?: string;
  onProgress?: (status: string, completed?: number, total?: number) => void;
  signal?: AbortSignal;
}

export async function pullOllamaModel(modelName: string, opts?: PullOptions): Promise<PullResult> {
  const baseUrl = (opts?.baseUrl ?? OLLAMA_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/api/pull`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
      signal: opts?.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    return { success: false, error: `HTTP ${response.status}: ${text}` };
  }

  if (!response.body) {
    return { success: false, error: "Empty response body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastError: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const chunk = JSON.parse(trimmed) as PullProgress;
          if (chunk.error) {
            lastError = chunk.error;
          }
          opts?.onProgress?.(chunk.status, chunk.completed, chunk.total);
        } catch {
          // skip malformed lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as PullProgress;
        if (chunk.error) {
          lastError = chunk.error;
        }
        opts?.onProgress?.(chunk.status, chunk.completed, chunk.total);
      } catch {
        // skip
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }

  if (lastError) {
    return { success: false, error: lastError };
  }

  return { success: true };
}
