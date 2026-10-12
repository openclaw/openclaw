import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  MediaFetchError,
  parseMediaContentLength,
  readResponseTextSnippet,
} from "openclaw/plugin-sdk/media-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { shouldSuppressGoogleChatManualExecApprovalFollowupText } from "./approval-card-actions.js";
import { getGoogleChatAccessToken } from "./auth.js";
import { rememberGoogleChatSpace } from "./space-cache.js";
import type { GoogleChatCardV2, GoogleChatSpace } from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const GOOGLECHAT_API_TIMEOUT_MS = 30_000;
const GOOGLECHAT_MEDIA_TIMEOUT_GRACE_MS = 30_000;
const GOOGLECHAT_MEDIA_MIN_BYTES_PER_SECOND = 256 * 1024;
const GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS = 15 * 60_000;
const GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS = 30_000;
const GOOGLECHAT_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLECHAT_ERROR_BODY_MAX_BYTES = 16 * 1024;
const GOOGLE_CHAT_DEFAULT_MEDIA_MAX_MB = 20;
const GOOGLE_CHAT_MEDIA_RESPONSE_MAX_BYTES = GOOGLE_CHAT_DEFAULT_MEDIA_MAX_MB * 1024 * 1024;

type GoogleChatRequestHooks = Pick<
  ChannelMessageActionContext,
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

export class GoogleChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleChatApiError";
  }
}

function resolveGoogleChatMediaTimeoutMs(maxBytes?: number): number {
  if (!maxBytes) {
    return GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS;
  }
  const transferMs = Math.ceil((maxBytes / GOOGLECHAT_MEDIA_MIN_BYTES_PER_SECOND) * 1000);
  return Math.min(GOOGLECHAT_MEDIA_TIMEOUT_GRACE_MS + transferMs, GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS);
}

async function readGoogleChatErrorResponse(response: Response): Promise<string> {
  const text =
    (await readResponseTextSnippet(response, {
      maxBytes: GOOGLECHAT_ERROR_BODY_MAX_BYTES,
      maxChars: GOOGLECHAT_ERROR_BODY_MAX_BYTES,
      chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`Google Chat API error response stalled after ${chunkTimeoutMs}ms`),
    })) ?? "";
  // Remote API errors can reflect the request's Authorization header. Force
  // tool-payload redaction before the text enters any surfaced error message.
  return redactToolPayloadText(text);
}

async function withGoogleChatResponse<T>(
  params: GoogleChatRequestHooks & {
    account: ResolvedGoogleChatAccount;
    url: string;
    init?: Pick<RequestInit, "method" | "body"> & { headers?: Record<string, string> };
    auditContext: string;
    timeoutMs?: number;
    handleResponse: (response: Response) => Promise<T>;
  },
): Promise<T> {
  const {
    account,
    url,
    init,
    auditContext,
    timeoutMs = GOOGLECHAT_API_TIMEOUT_MS,
    handleResponse,
    assertDirectAdapterHandoff,
    onPlatformSendDispatch,
  } = params;
  assertDirectAdapterHandoff?.();
  const token = await getGoogleChatAccessToken(account);
  if (onPlatformSendDispatch) {
    // Preparatory reads never mark a recipient-visible send as dispatched.
    assertDirectAdapterHandoff?.();
    await onPlatformSendDispatch();
  }
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    },
    auditContext,
    timeoutMs,
    // The guard checks again after network preparation and on each redirect.
    beforeRequest: assertDirectAdapterHandoff,
  });
  try {
    if (!response.ok) {
      const text = await readGoogleChatErrorResponse(response);
      throw new GoogleChatApiError(
        response.status,
        `Google Chat API ${response.status}: ${text || response.statusText}`,
      );
    }
    return await handleResponse(response);
  } finally {
    // Status-only responses leave an unread body. Start cancellation before
    // release; awaiting it can deadlock when debug capture tees the stream.
    if (!response.bodyUsed) {
      void response.body?.cancel().catch(() => undefined);
    }
    await release();
  }
}

async function fetchJson<T>(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: Pick<RequestInit, "method" | "body">,
  hooks?: GoogleChatRequestHooks,
): Promise<T> {
  return await withGoogleChatResponse({
    ...hooks,
    account,
    url,
    init: {
      ...init,
      headers: {
        "Content-Type": "application/json",
      },
    },
    auditContext: "googlechat.api.json",
    handleResponse: async (response) =>
      await readProviderJsonResponse<T>(response, "Google Chat API request failed", {
        maxBytes: GOOGLECHAT_JSON_RESPONSE_MAX_BYTES,
        chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(
            `Google Chat API request failed: response body stalled after ${chunkTimeoutMs}ms`,
          ),
      }),
  });
}

export async function downloadGoogleChatMedia(params: {
  account: ResolvedGoogleChatAccount;
  resourceName: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType?: string }> {
  const { account, resourceName, maxBytes: requestedMaxBytes } = params;
  const url = `${CHAT_API_BASE}/media/${resourceName}?alt=media`;
  return await withGoogleChatResponse({
    account,
    url,
    auditContext: "googlechat.api.buffer",
    // Media gets transfer time proportional to its accepted size, while a silent
    // response body is still bounded independently below.
    timeoutMs: resolveGoogleChatMediaTimeoutMs(requestedMaxBytes),
    handleResponse: async (res) => {
      const maxBytes = requestedMaxBytes ?? GOOGLE_CHAT_MEDIA_RESPONSE_MAX_BYTES;
      const lengthHeader = res.headers.get("content-length");
      if (lengthHeader) {
        const length = parseMediaContentLength(lengthHeader);
        if (length !== null && length > maxBytes) {
          throw new MediaFetchError(
            "max_bytes",
            `Google Chat media exceeds max bytes (${maxBytes})`,
          );
        }
      }
      const buffer = await readResponseWithLimit(res, maxBytes, {
        chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
        onOverflow: () =>
          new MediaFetchError("max_bytes", `Google Chat media exceeds max bytes (${maxBytes})`),
      });
      const contentType = res.headers.get("content-type") ?? undefined;
      return { buffer, contentType };
    },
  });
}

// Invalid or cross-space thread names make Chat reject the entire send. Drop
// them so the message still reaches the space as a new thread.
function isUsableGoogleChatThreadName(thread: string, space: string): boolean {
  return /^spaces\/[^/]+\/threads\/[^/]+$/.test(thread) && thread.startsWith(`${space}/threads/`);
}

export async function sendGoogleChatMessage(
  params: GoogleChatRequestHooks & {
    account: ResolvedGoogleChatAccount;
    space: string;
    text?: string;
    thread?: string;
    cardsV2?: GoogleChatCardV2[];
  },
): Promise<{ messageName?: string; threadName?: string } | null> {
  const { account, space, text, thread, cardsV2 } = params;
  const usableThread = thread && isUsableGoogleChatThreadName(thread, space) ? thread : undefined;
  if (
    text &&
    (!cardsV2 || cardsV2.length === 0) &&
    shouldSuppressGoogleChatManualExecApprovalFollowupText(text)
  ) {
    return null;
  }
  const urlObj = new URL(`${CHAT_API_BASE}/${space}/messages`);
  if (usableThread) {
    urlObj.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  }
  const url = urlObj.toString();
  const result = await fetchJson<{
    name?: string;
    thread?: { name?: string };
    space?: GoogleChatSpace;
  }>(
    account,
    url,
    {
      method: "POST",
      body: JSON.stringify({
        text: text || undefined,
        cardsV2: cardsV2?.length ? cardsV2 : undefined,
        thread: usableThread ? { name: usableThread } : undefined,
      }),
    },
    {
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
    },
  );
  if (result?.space) {
    rememberGoogleChatSpace(account, { ...result.space, name: result.space.name ?? space });
  }
  return result ? { messageName: result.name, threadName: result.thread?.name } : null;
}

export async function updateGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  text?: string;
  cardsV2?: GoogleChatCardV2[];
}): Promise<{ messageName?: string }> {
  const { account, messageName, text, cardsV2 } = params;
  const updateMask = [
    ...(text !== undefined ? ["text"] : []),
    ...(cardsV2 !== undefined ? ["cardsV2"] : []),
  ];
  if (updateMask.length === 0) {
    throw new Error("Google Chat message update requires text or cardsV2.");
  }
  const url = `${CHAT_API_BASE}/${messageName}?updateMask=${updateMask.join(",")}`;
  const result = await fetchJson<{ name?: string }>(account, url, {
    method: "PATCH",
    body: JSON.stringify({ text, cardsV2 }),
  });
  return { messageName: result.name };
}

export async function deleteGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
}): Promise<void> {
  const { account, messageName } = params;
  const url = `${CHAT_API_BASE}/${messageName}`;
  await withGoogleChatResponse({
    account,
    url,
    init: { method: "DELETE" },
    auditContext: "googlechat.api.ok",
    handleResponse: async () => undefined,
  });
}

export async function findGoogleChatDirectMessage(params: {
  account: ResolvedGoogleChatAccount;
  userName: string;
  assertDirectAdapterHandoff?: () => void;
}): Promise<GoogleChatSpace | null> {
  const { account, userName } = params;
  const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
  url.searchParams.set("name", userName);
  return await fetchJson<GoogleChatSpace>(
    account,
    url.toString(),
    { method: "GET" },
    { assertDirectAdapterHandoff: params.assertDirectAdapterHandoff },
  );
}

export async function getGoogleChatSpace(params: {
  account: ResolvedGoogleChatAccount;
  spaceName: string;
  assertDirectAdapterHandoff?: () => void;
}): Promise<GoogleChatSpace> {
  return await fetchJson<GoogleChatSpace>(
    params.account,
    `${CHAT_API_BASE}/${params.spaceName}`,
    { method: "GET" },
    { assertDirectAdapterHandoff: params.assertDirectAdapterHandoff },
  );
}

export async function probeGoogleChat(account: ResolvedGoogleChatAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const url = new URL(`${CHAT_API_BASE}/spaces`);
    url.searchParams.set("pageSize", "1");
    await fetchJson<Record<string, unknown>>(account, url.toString(), {
      method: "GET",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}
