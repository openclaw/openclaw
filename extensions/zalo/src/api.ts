/**
 * Zalo Bot API client
 * @see https://bot.zaloplatforms.com/docs
 */

import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { z } from "zod";
import type { webhookMessageSchema, webhookUpdateSchema } from "./message-schema.js";
import { ZALO_DEFAULT_REQUEST_TIMEOUT_MS, ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS } from "./timeouts.js";

const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_API_URL_ENV = "ZALO_API_URL";
const ZALO_MEDIA_SSRF_POLICY: SsrFPolicy = {};

export type ZaloFetch = (input: string, init?: RequestInit) => Promise<Response>;

type ZaloApiResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

export type ZaloBotInfo = {
  id: string;
  account_name: string;
  account_type: string;
  can_join_groups: boolean;
};

export type ZaloMessage = z.infer<typeof webhookMessageSchema>;

export type ZaloUpdate = Omit<z.infer<typeof webhookUpdateSchema>, "message"> & {
  message?: ZaloMessage;
};

type ZaloSendMessageParams = {
  chat_id: string;
  text: string;
};

type ZaloSendPhotoParams = {
  chat_id: string;
  photo: string;
  caption?: string;
};

type ZaloSendChatActionParams = {
  chat_id: string;
  action: "typing" | "upload_photo";
};

type ZaloSetWebhookParams = {
  url: string;
  secret_token: string;
};

type ZaloWebhookInfo = {
  url?: string;
  updated_at?: number;
  has_custom_certificate?: boolean;
};

type ZaloGetUpdatesParams = {
  /** Timeout in seconds (passed as string to API) */
  timeout?: number;
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

function resolveZaloApiUrl(): string {
  const value = process.env[ZALO_API_URL_ENV]?.trim() ?? ZALO_API_BASE;
  if (!value) {
    throw new Error(`${ZALO_API_URL_ENV} must not be empty.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ZALO_API_URL_ENV} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${ZALO_API_URL_ENV} must use http:// or https://.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${ZALO_API_URL_ENV} must not include a query string or fragment.`);
  }
  return parsed.href.replace(/\/+$/u, "");
}

export async function callZaloApi<T = unknown>(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  options?: {
    timeoutMs?: number;
    fetch?: ZaloFetch;
    assertDirectAdapterHandoff?: () => void;
  },
): Promise<ZaloApiResponse<T>> {
  const url = `${resolveZaloApiUrl()}/bot${token}/${method}`;
  const controller = new AbortController();
  const requestTimeoutMs = resolveTimerTimeoutMs(
    options?.timeoutMs,
    ZALO_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
  const fetcher = options?.fetch ?? fetch;

  try {
    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    const response = await captureEffectAuthority().initiate(() => {
      options?.assertDirectAdapterHandoff?.();
      return fetcher(url, request);
    });

    await assertOkOrThrowProviderError(response, `zalo.${method}`);
    const data = await readProviderJsonResponse<ZaloApiResponse<T>>(response, `zalo.${method}`);

    if (!data.ok) {
      throw new ZaloApiError(
        data.description ?? `Zalo API error: ${method}`,
        data.error_code,
        data.description,
      );
    }

    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getMe(
  token: string,
  timeoutMs?: number,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloBotInfo>> {
  return callZaloApi<ZaloBotInfo>("getMe", token, undefined, { timeoutMs, fetch: fetcher });
}

export async function sendMessage(
  token: string,
  params: ZaloSendMessageParams,
  fetcher?: ZaloFetch,
  assertDirectAdapterHandoff?: () => void,
): Promise<ZaloApiResponse<ZaloMessage>> {
  return callZaloApi<ZaloMessage>("sendMessage", token, params, {
    fetch: fetcher,
    assertDirectAdapterHandoff,
  });
}

export async function sendPhoto(
  token: string,
  params: ZaloSendPhotoParams,
  fetcher?: ZaloFetch,
  assertDirectAdapterHandoff?: () => void,
): Promise<ZaloApiResponse<ZaloMessage>> {
  const photoUrl = params.photo.trim();
  let parsedPhotoUrl: URL;
  try {
    parsedPhotoUrl = new URL(photoUrl);
  } catch {
    throw new Error("Zalo photo URL must be an absolute HTTP or HTTPS URL");
  }

  if (parsedPhotoUrl.protocol !== "http:" && parsedPhotoUrl.protocol !== "https:") {
    throw new Error("Zalo photo URL must use HTTP or HTTPS");
  }

  await resolvePinnedHostnameWithPolicy(parsedPhotoUrl.hostname, {
    policy: ZALO_MEDIA_SSRF_POLICY,
  });

  return callZaloApi<ZaloMessage>(
    "sendPhoto",
    token,
    {
      ...params,
      photo: parsedPhotoUrl.href,
      caption: params.caption === undefined ? undefined : truncateUtf16Safe(params.caption, 2000),
    },
    {
      // Zalo receives a URL-only JSON body and may resolve that URL before replying.
      // Wait through the hosted-media lifetime plus normal response-processing grace.
      timeoutMs: ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS,
      fetch: fetcher,
      assertDirectAdapterHandoff,
    },
  );
}

export async function sendChatAction(
  token: string,
  params: ZaloSendChatActionParams,
  fetcher?: ZaloFetch,
  timeoutMs?: number,
): Promise<ZaloApiResponse<boolean>> {
  return callZaloApi<boolean>("sendChatAction", token, params, {
    timeoutMs,
    fetch: fetcher,
  });
}

/**
 * Note: Zalo returns a single update per call, not an array like Telegram
 */
export async function getUpdates(
  token: string,
  params?: ZaloGetUpdatesParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloUpdate>> {
  const pollTimeoutSec = params?.timeout ?? 30;
  const timeoutMs = (pollTimeoutSec + 5) * 1000;
  const body = { timeout: String(pollTimeoutSec) };
  return callZaloApi<ZaloUpdate>("getUpdates", token, body, { timeoutMs, fetch: fetcher });
}

export async function setWebhook(
  token: string,
  params: ZaloSetWebhookParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("setWebhook", token, params, { fetch: fetcher });
}

export async function deleteWebhook(
  token: string,
  fetcher?: ZaloFetch,
  timeoutMs?: number,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("deleteWebhook", token, undefined, {
    timeoutMs,
    fetch: fetcher,
  });
}

export async function getWebhookInfo(
  token: string,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloWebhookInfo>> {
  return callZaloApi<ZaloWebhookInfo>("getWebhookInfo", token, undefined, { fetch: fetcher });
}
