import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rememberBlueBubblesReplyCache } from "./monitor-reply-cache.js";
import { normalizeBlueBubblesHandle } from "./targets.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

const DEFAULT_REPLY_FETCH_TIMEOUT_MS = 5_000;

export type BlueBubblesReplyFetchResult = {
  body?: string;
  sender?: string;
};

/**
 * In-flight dedupe so concurrent webhooks for replies to the same message
 * (e.g., several recipients in a group chat replying near-simultaneously)
 * coalesce into a single BlueBubbles HTTP fetch.
 *
 * Key shape: `${accountId}:${replyToId}` to keep accounts isolated.
 */
const inflight = new Map<string, Promise<BlueBubblesReplyFetchResult | null>>();

/**
 * @internal Reset shared module state. Test-only.
 */
export function _resetBlueBubblesReplyFetchState(): void {
  inflight.clear();
}

type ReplyContextFetchAccountConfig = Parameters<typeof isPrivateNetworkOptInEnabled>[0];

export type FetchBlueBubblesReplyContextParams = {
  accountId: string;
  replyToId: string;
  baseUrl: string;
  password: string;
  /** Optional account config — used to resolve the SSRF private-network opt-in. */
  accountConfig?: ReplyContextFetchAccountConfig;
  /** Optional chat scope used to populate the reply cache for subsequent hits. */
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  /** Defaults to 5_000 ms. */
  timeoutMs?: number;
  /** Override the underlying fetch. Test seam. */
  fetchImpl?: typeof blueBubblesFetchWithTimeout;
};

/**
 * Best-effort fallback: when the local in-memory reply cache misses, ask the
 * BlueBubbles HTTP API for the original message so the agent still gets reply
 * context. Returns `null` on any failure (network error, non-2xx, parse error,
 * empty payload). Never throws.
 *
 * On success, the cache is populated so subsequent replies to the same message
 * resolve from RAM without another round-trip.
 *
 * Cache misses happen in legitimate, common deployments: multi-instance setups
 * sharing one BB account, container/process restarts, cross-tenant shared
 * groups, and long-lived chats where TTL/LRU has evicted the message.
 */
export function fetchBlueBubblesReplyContext(
  params: FetchBlueBubblesReplyContextParams,
): Promise<BlueBubblesReplyFetchResult | null> {
  const replyToId = params.replyToId.trim();
  if (!replyToId || !params.baseUrl || !params.password) {
    return Promise.resolve(null);
  }
  const key = `${params.accountId}:${replyToId}`;
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = runFetch(params, replyToId).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function runFetch(
  params: FetchBlueBubblesReplyContextParams,
  replyToId: string,
): Promise<BlueBubblesReplyFetchResult | null> {
  const fetchImpl = params.fetchImpl ?? blueBubblesFetchWithTimeout;
  try {
    const url = buildBlueBubblesApiUrl({
      baseUrl: params.baseUrl,
      path: `/api/v1/message/${encodeURIComponent(replyToId)}`,
      password: params.password,
    });
    const ssrfPolicy =
      params.accountConfig && isPrivateNetworkOptInEnabled(params.accountConfig)
        ? ({ allowPrivateNetwork: true as const } as const)
        : undefined;
    const response = await fetchImpl(
      url,
      { method: "GET" },
      params.timeoutMs ?? DEFAULT_REPLY_FETCH_TIMEOUT_MS,
      ssrfPolicy,
    );
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as Record<string, unknown>;
    const data = (json.data ?? json) as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") {
      return null;
    }
    const body = extractBody(data);
    const sender = extractSender(data);
    if (!body && !sender) {
      return null;
    }
    if (body || sender) {
      rememberBlueBubblesReplyCache({
        accountId: params.accountId,
        messageId: replyToId,
        chatGuid: params.chatGuid,
        chatIdentifier: params.chatIdentifier,
        chatId: params.chatId,
        senderLabel: sender,
        body,
        timestamp: Date.now(),
      });
    }
    return { body, sender };
  } catch {
    // Best-effort: swallow network/parse errors. Caller proceeds with empty
    // reply context, which matches existing pre-fallback behavior.
    return null;
  }
}

function extractBody(data: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(data.text) ??
    normalizeOptionalString(data.body) ??
    normalizeOptionalString(data.subject)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractSender(data: Record<string, unknown>): string | undefined {
  const handle = asRecord(data.handle) ?? asRecord(data.sender);
  const raw =
    normalizeOptionalString(handle?.address) ??
    normalizeOptionalString(handle?.id) ??
    normalizeOptionalString(data.senderId) ??
    normalizeOptionalString(data.sender);
  if (!raw) {
    return undefined;
  }
  return normalizeBlueBubblesHandle(raw) || raw;
}
