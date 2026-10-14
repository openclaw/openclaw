import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { z } from "zod";

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
  checkAbort(signal, label);
  try {
    await sleepWithAbort(ms, signal);
  } catch (error) {
    checkAbort(signal, label);
    throw error;
  }
  checkAbort(signal, label);
}

export function parseApiBase(raw: string, label: string): URL {
  const base = URL.parse(`${raw.replace(/\/+$/, "")}/`);
  if (!base) {
    throw new Error(`${label} API base URL is invalid.`);
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error(
      `${label} API base URL must use HTTPS without credentials, query, or fragment.`,
    );
  }
  return base;
}
