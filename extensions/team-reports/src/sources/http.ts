import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import type { z } from "zod";

export class SourceResponseTooLargeError extends Error {}

export function readSourceResponseText(
  response: Response,
  source: string,
  signal: AbortSignal,
): Promise<string> {
  // The SDK reader owns the byte/idle bounds and cancels overflow before guarded release.
  return readProviderTextResponse(response, `Team Reports ${source} API`, {
    signal,
    onOverflow: ({ maxBytes }) =>
      new SourceResponseTooLargeError(
        `${source} API response exceeded the ${maxBytes / 1024 / 1024} MiB safety limit; check API compatibility and retry.`,
      ),
  });
}

export function createResponseParser(createError: () => Error) {
  return <T>(schema: z.ZodType<T>, data: unknown): T => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw createError();
    }
    return parsed.data;
  };
}

export function checkAbort(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    // Abort reasons and transport errors may contain credentials supplied by callers.
    throw new DOMException(label, "AbortError");
  }
}

export async function wait(
  ms: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  // Node timers overflow above 2^31-1; chunk long reset delays without polling the API.
  const deadline = Date.now() + ms;
  do {
    checkAbort(signal, label);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException(label, "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } while (Date.now() < deadline);
  checkAbort(signal, label);
}

export function parseApiBase(raw: string, label: string): URL {
  let base: URL;
  try {
    base = new URL(`${raw.replace(/\/+$/, "")}/`);
  } catch {
    throw new Error(`${label} API base URL is invalid.`);
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error(
      `${label} API base URL must use HTTPS without credentials, query, or fragment.`,
    );
  }
  return base;
}
