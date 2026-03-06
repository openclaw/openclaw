/**
 * Zalo Bot API client
 * @see https://bot.zaloplatforms.com/docs
 */

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const NON_JSON_SNIPPET_MAX_CHARS = 220;

export type ZaloFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ZaloApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export type ZaloBotInfo = {
  id: string;
  name: string;
  avatar?: string;
};

export type ZaloMessage = {
  message_id: string;
  from: {
    id: string;
    name?: string;
    display_name?: string;
    avatar?: string;
    is_bot?: boolean;
  };
  chat: {
    id: string;
    chat_type: "PRIVATE" | "GROUP";
  };
  date: number;
  message_type?: string;
  text?: string;
  url?: string;
  photo_url?: string;
  photo?:
    | string
    | {
        url?: string;
        media_url?: string;
        download_url?: string;
        src?: string;
      }
    | Array<
        | string
        | {
            url?: string;
            media_url?: string;
            download_url?: string;
            src?: string;
          }
      >;
  caption?: string;
  sticker?: string;
  link?: {
    url?: string;
    title?: string;
    description?: string;
  };
  links?: Array<{
    url?: string;
    title?: string;
    description?: string;
  }>;
  attachments?: Array<{
    type?: string;
    media_type?: string;
    url?: string;
    title?: string;
    description?: string;
    payload?: Record<string, unknown>;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
};

export type ZaloKnownEventName =
  | "message.text.received"
  | "message.image.received"
  | "message.link.received"
  | "message.sticker.received"
  | "message.unsupported.received";

export type ZaloUpdate = {
  event_name: ZaloKnownEventName | (string & {});
  message?: ZaloMessage;
};

export type ZaloSendMessageParams = {
  chat_id: string;
  text: string;
};

export type ZaloSendPhotoParams = {
  chat_id: string;
  photo: string;
  caption?: string;
};

export type ZaloSetWebhookParams = {
  url: string;
  secret_token: string;
};

export type ZaloGetUpdatesParams = {
  /** Timeout in seconds (passed as string to API) */
  timeout?: number;
  /** Extra buffer for network/body parse time beyond long-poll timeout. */
  timeoutBufferMs?: number;
  /** External abort signal (for provider shutdown/cancellation). */
  abortSignal?: AbortSignal;
};

export class ZaloApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = "ZaloApiError";
  }

  /** True if this is a long-polling timeout (no updates available) */
  get isPollingTimeout(): boolean {
    return this.errorCode === 408;
  }
}

export class ZaloApiAbortError extends Error {
  constructor(
    message: string,
    public readonly reason: "timeout" | "aborted",
  ) {
    super(message);
    this.name = "ZaloApiAbortError";
  }

  get isTimeout(): boolean {
    return this.reason === "timeout";
  }

  get isAborted(): boolean {
    return this.reason === "aborted";
  }
}

export type ZaloApiCallOptions = {
  timeoutMs?: number;
  fetch?: ZaloFetch;
  abortSignal?: AbortSignal;
};

function formatBodySnippet(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "<empty>";
  }
  if (compact.length <= NON_JSON_SNIPPET_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, NON_JSON_SNIPPET_MAX_CHARS)}...`;
}

/**
 * Call the Zalo Bot API
 */
export async function callZaloApi<T = unknown>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  options?: ZaloApiCallOptions,
): Promise<ZaloApiResponse<T>> {
  const url = `${ZALO_API_BASE}/bot${token}/${method}`;
  const controller = new AbortController();
  let didTimeout = false;
  let didAbortExternally = false;
  const timeoutId = options?.timeoutMs
    ? setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, options.timeoutMs)
    : undefined;
  const abortSignal = options?.abortSignal;
  const onExternalAbort = () => {
    didAbortExternally = true;
    controller.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onExternalAbort();
    } else {
      abortSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const fetcher = options?.fetch ?? fetch;

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let data: ZaloApiResponse<T>;
    try {
      data = JSON.parse(rawBody) as ZaloApiResponse<T>;
    } catch {
      const contentType = response.headers.get("content-type")?.trim();
      const contentTypePart = contentType ? `, content-type ${contentType}` : "";
      const snippet = formatBodySnippet(rawBody);
      throw new ZaloApiError(
        `Zalo API returned non-JSON response for ${method} (status ${response.status}${contentTypePart}); body: ${snippet}`,
        response.status,
      );
    }

    if (!data.ok) {
      throw new ZaloApiError(
        data.description ?? `Zalo API error: ${method}`,
        data.error_code,
        data.description,
      );
    }

    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (didTimeout) {
        throw new ZaloApiAbortError(`Zalo API request timed out for ${method}`, "timeout");
      }
      if (didAbortExternally) {
        throw new ZaloApiAbortError(`Zalo API request aborted for ${method}`, "aborted");
      }
    }
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortSignal) {
      abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Validate bot token and get bot info
 */
export async function getMe(
  token: string,
  timeoutMs?: number,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloBotInfo>> {
  return callZaloApi<ZaloBotInfo>("getMe", token, undefined, { timeoutMs, fetch: fetcher });
}

/**
 * Send a text message
 */
export async function sendMessage(
  token: string,
  params: ZaloSendMessageParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloMessage>> {
  return callZaloApi<ZaloMessage>("sendMessage", token, params, { fetch: fetcher });
}

/**
 * Send a photo message
 */
export async function sendPhoto(
  token: string,
  params: ZaloSendPhotoParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloMessage>> {
  return callZaloApi<ZaloMessage>("sendPhoto", token, params, { fetch: fetcher });
}

/**
 * Get updates using long polling (dev/testing only)
 * Note: Zalo returns a single update per call, not an array like Telegram
 */
export async function getUpdates(
  token: string,
  params?: ZaloGetUpdatesParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloUpdate>> {
  const pollTimeoutSec = params?.timeout ?? 30;
  const timeoutBufferMs = params?.timeoutBufferMs ?? 20_000;
  const timeoutMs = pollTimeoutSec * 1000 + timeoutBufferMs;
  const body = { timeout: String(pollTimeoutSec) };
  return callZaloApi<ZaloUpdate>("getUpdates", token, body, {
    timeoutMs,
    fetch: fetcher,
    abortSignal: params?.abortSignal,
  });
}

/**
 * Set webhook URL for receiving updates
 */
export async function setWebhook(
  token: string,
  params: ZaloSetWebhookParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<boolean>> {
  return callZaloApi<boolean>("setWebhook", token, params, { fetch: fetcher });
}

/**
 * Delete webhook configuration
 */
export async function deleteWebhook(
  token: string,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<boolean>> {
  return callZaloApi<boolean>("deleteWebhook", token, undefined, { fetch: fetcher });
}

/**
 * Get current webhook info
 */
export async function getWebhookInfo(
  token: string,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<{ url?: string; has_custom_certificate?: boolean }>> {
  return callZaloApi("getWebhookInfo", token, undefined, { fetch: fetcher });
}
