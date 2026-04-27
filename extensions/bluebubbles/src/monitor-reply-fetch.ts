import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
  resolveBlueBubblesPrivateNetworkConfigValue,
} from "./accounts-normalization.js";
import { resolveBlueBubblesClientSsrfPolicy } from "./client.js";
import { rememberBlueBubblesReplyCache } from "./monitor-reply-cache.js";
import { normalizeBlueBubblesHandle } from "./targets.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesAccountConfig,
} from "./types.js";

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

export type FetchBlueBubblesReplyContextParams = {
  accountId: string;
  replyToId: string;
  baseUrl: string;
  password: string;
  /**
   * Optional account config — used to resolve the SSRF policy for this fetch
   * via the same three-mode resolver the BlueBubbles client uses. Even when
   * omitted the request is still SSRF-guarded; we never pass `undefined` to
   * the underlying fetch helper.
   */
  accountConfig?: BlueBubblesAccountConfig;
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
    // Resolve the SSRF policy through the same three-mode helper the BB
    // client uses (mode 1: explicit private-network opt-in, mode 2: hostname
    // allowlist for trusted self-hosted servers, mode 3: default-deny guard).
    // The resolver never returns `undefined`, so this fetch is always routed
    // through `fetchWithSsrFGuard`. Previously we passed `undefined` when the
    // user had not opted in to private-network access, which silently skipped
    // the guard entirely. (PR #71820 review)
    const { ssrfPolicy } = resolveBlueBubblesClientSsrfPolicy({
      baseUrl: params.baseUrl,
      allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig({
        baseUrl: params.baseUrl,
        config: params.accountConfig,
      }),
      allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(params.accountConfig),
    });
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
