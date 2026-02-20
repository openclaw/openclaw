// ---------------------------------------------------------------------------
// Inlined utilities – these are NOT exported from openclaw/plugin-sdk, so we
// carry local copies to keep the plugin self-contained.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ToolInputError (from src/agents/tools/common.ts)
// ---------------------------------------------------------------------------

export class ToolInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

// ---------------------------------------------------------------------------
// readStringArrayParam (from src/agents/tools/common.ts)
// ---------------------------------------------------------------------------

type StringParamOptions = {
  required?: boolean;
  label?: string;
};

export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string[];
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string[] | undefined;
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, label = key } = options;
  const raw = params[key];
  if (Array.isArray(raw)) {
    const values = raw
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0) {
      if (required) {
        throw new ToolInputError(`${label} required`);
      }
      return undefined;
    }
    return values;
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      if (required) {
        throw new ToolInputError(`${label} required`);
      }
      return undefined;
    }
    return [value];
  }
  if (required) {
    throw new ToolInputError(`${label} required`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// normalizeSecretInput (from src/utils/normalize-secret-input.ts)
// ---------------------------------------------------------------------------

export function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}

// ---------------------------------------------------------------------------
// Cache utilities (from src/agents/tools/web-shared.ts)
// ---------------------------------------------------------------------------

export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  insertedAt: number;
};

export const DEFAULT_CACHE_TTL_MINUTES = 15;
const DEFAULT_CACHE_MAX_ENTRIES = 100;

export function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number {
  const minutes =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallbackMinutes;
  return Math.round(minutes * 60_000);
}

export function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

export function readCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): { value: T; cached: boolean } | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, cached: true };
}

export function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  if (ttlMs <= 0) {
    return;
  }
  if (cache.size >= DEFAULT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    insertedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// HTTP utilities (from src/agents/tools/web-shared.ts)
// ---------------------------------------------------------------------------

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) {
    return signal ?? new AbortController().signal;
  }
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

export type ReadResponseTextResult = {
  text: string;
  truncated: boolean;
  bytesRead: number;
};

export async function readResponseText(
  res: Response,
  options?: { maxBytes?: number },
): Promise<ReadResponseTextResult> {
  const maxBytesRaw = options?.maxBytes;
  const maxBytes =
    typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.floor(maxBytesRaw)
      : undefined;

  const body = (res as unknown as { body?: unknown }).body;
  if (
    maxBytes &&
    body &&
    typeof body === "object" &&
    "getReader" in body &&
    typeof (body as { getReader: () => unknown }).getReader === "function"
  ) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let truncated = false;
    const parts: string[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        let chunk = value;
        if (bytesRead + chunk.byteLength > maxBytes) {
          const remaining = Math.max(0, maxBytes - bytesRead);
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          chunk = chunk.subarray(0, remaining);
          truncated = true;
        }

        bytesRead += chunk.byteLength;
        parts.push(decoder.decode(chunk, { stream: true }));

        if (truncated || bytesRead >= maxBytes) {
          truncated = true;
          break;
        }
      }
    } catch {
      // Best-effort: return whatever we decoded so far.
    } finally {
      if (truncated) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }
    }

    parts.push(decoder.decode());
    return { text: parts.join(""), truncated, bytesRead };
  }

  try {
    const text = await res.text();
    return { text, truncated: false, bytesRead: text.length };
  } catch {
    return { text: "", truncated: false, bytesRead: 0 };
  }
}

// ---------------------------------------------------------------------------
// External content wrapping (simplified from src/security/external-content.ts)
// ---------------------------------------------------------------------------

const EXTERNAL_CONTENT_START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const EXTERNAL_CONTENT_END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";

function sanitizeMarkers(content: string): string {
  return content
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT>>>/gi, "[[MARKER_SANITIZED]]")
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>/gi, "[[END_MARKER_SANITIZED]]");
}

export function wrapExternalContent(
  content: string,
  options: { source: string; includeWarning?: boolean },
): string {
  const sanitized = sanitizeMarkers(content);
  const metadata = `Source: ${options.source}`;

  return [EXTERNAL_CONTENT_START, metadata, "---", sanitized, EXTERNAL_CONTENT_END].join("\n");
}
