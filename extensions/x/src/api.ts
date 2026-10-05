import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import { X_POST_READ_MICRO_USD, X_USER_READ_MICRO_USD, xReadCost, xReplyCost } from "./pricing.js";
import { XBudgetExceededError, type XSpend } from "./spend.js";

const X_API_ORIGIN = "https://api.x.com";
const POST_FIELDS =
  "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets,entities";

export type XPost = {
  id: string;
  text: string;
  author_id: string;
  conversation_id: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  entities?: { mentions?: { id?: string; username: string }[] };
};
export type XUser = { id: string; username: string; name?: string };
export type XPage = {
  data: XPost[];
  includes: { users: XUser[]; tweets: XPost[] };
  meta: { newest_id?: string; next_token?: string };
};
export type XPostEnvelope = { post: XPost; users: XUser[]; recipientPending?: true };
export type XFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type XTokenState = "idle" | "refreshing" | "ready" | "error";
export type XAssertActive = () => void | (() => void) | Promise<void | (() => void)>;

export class XApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly operation: string,
  ) {
    super(`X API ${operation} failed (HTTP ${status})`);
    this.name = "XApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("X API returned an unreadable JSON response");
  }
}

export function parseXPost(input: unknown): XPost | undefined {
  const row = record(input);
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^\d+$/.test(row.id) ||
    typeof row.text !== "string" ||
    typeof row.author_id !== "string" ||
    !/^\d+$/.test(row.author_id) ||
    typeof row.conversation_id !== "string" ||
    !/^\d+$/.test(row.conversation_id)
  ) {
    return undefined;
  }
  const references: NonNullable<XPost["referenced_tweets"]> = [];
  for (const value of Array.isArray(row.referenced_tweets) ? row.referenced_tweets : []) {
    const reference = record(value);
    if (
      reference &&
      typeof reference.id === "string" &&
      /^\d+$/.test(reference.id) &&
      (reference.type === "replied_to" ||
        reference.type === "quoted" ||
        reference.type === "retweeted")
    ) {
      references.push({ id: reference.id, type: reference.type });
    }
  }
  const entities = record(row.entities);
  const mentions: { id?: string; username: string }[] = [];
  for (const value of Array.isArray(entities?.mentions) ? entities.mentions : []) {
    const mention = record(value);
    if (mention && typeof mention.username === "string") {
      mentions.push({
        username: mention.username,
        ...(typeof mention.id === "string" ? { id: mention.id } : {}),
      });
    }
  }
  return {
    id: row.id,
    text: row.text,
    author_id: row.author_id,
    conversation_id: row.conversation_id,
    ...(typeof row.created_at === "string" ? { created_at: row.created_at } : {}),
    ...(typeof row.in_reply_to_user_id === "string"
      ? { in_reply_to_user_id: row.in_reply_to_user_id }
      : {}),
    ...(references.length ? { referenced_tweets: references } : {}),
    ...(entities ? { entities: Array.isArray(entities.mentions) ? { mentions } : {} } : {}),
  };
}

function parseUser(value: unknown): XUser | undefined {
  const row = record(value);
  return row &&
    typeof row.id === "string" &&
    /^\d+$/.test(row.id) &&
    typeof row.username === "string"
    ? {
        id: row.id,
        username: row.username,
        ...(typeof row.name === "string" ? { name: row.name } : {}),
      }
    : undefined;
}

export function parseXPostEnvelope(input: unknown): XPostEnvelope | undefined {
  const row = record(input);
  const post = parseXPost(row?.post);
  return post
    ? {
        post,
        users: (Array.isArray(row?.users) ? row.users : []).flatMap(
          (value) => parseUser(value) ?? [],
        ),
        ...(row?.recipientPending === true ? { recipientPending: true } : {}),
      }
    : undefined;
}

function parsePage(input: unknown): XPage {
  const row = record(input);
  if (!row || (row.data !== undefined && !Array.isArray(row.data))) {
    throw new Error("X API returned an invalid post page");
  }
  const data = (row.data ?? []).map((value: unknown) => {
    const post = parseXPost(value);
    if (!post) {
      throw new Error("X API returned an invalid post");
    }
    return post;
  });
  const includes = record(row.includes);
  const meta = record(row.meta);
  return {
    data,
    includes: {
      users: (Array.isArray(includes?.users) ? includes.users : []).flatMap(
        (value) => parseUser(value) ?? [],
      ),
      tweets: (Array.isArray(includes?.tweets) ? includes.tweets : []).flatMap(
        (value) => parseXPost(value) ?? [],
      ),
    },
    meta: {
      ...(typeof meta?.newest_id === "string" ? { newest_id: meta.newest_id } : {}),
      ...(typeof meta?.next_token === "string" ? { next_token: meta.next_token } : {}),
    },
  };
}

export type XApiClient = ReturnType<typeof createXApiClient>;

export function createXApiClient(options: {
  spend: XSpend;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  bearerToken?: string;
  fetch?: XFetch;
  signal?: AbortSignal;
  loadRefreshToken?: () => Promise<string | undefined>;
  saveRefreshToken: (token: string) => Promise<void>;
  onTokenState?: (state: XTokenState) => void;
}) {
  let accessToken: string | undefined;
  let expiresAt = 0;
  let refreshToken = options.refreshToken;
  let loadedRefreshToken = false;
  let pendingRefreshToken: string | undefined;
  let refreshTask: Promise<void> | undefined;

  async function fetcher(
    url: string,
    init: RequestInit,
    assertActive?: XAssertActive,
    onDispatch?: () => void,
  ) {
    if (options.fetch) {
      const assertCurrent = await assertActive?.();
      init.signal?.throwIfAborted();
      assertCurrent?.();
      onDispatch?.();
      return options.fetch(url, init);
    }
    const [{ fetchWithSsrFGuard }, { responseWithRelease }, { fetchWithRuntimeDispatcher }] =
      await Promise.all([
        import("openclaw/plugin-sdk/ssrf-runtime"),
        import("openclaw/plugin-sdk/fetch-runtime"),
        import("openclaw/plugin-sdk/runtime-fetch"),
      ]);
    const guarded = await fetchWithSsrFGuard({
      url,
      init,
      capture: false,
      requireHttps: true,
      policy: { hostnameAllowlist: ["api.x.com"] },
      maxRedirects: 0,
      fetchImpl: async (input, prepared) => {
        const assertCurrent = await assertActive?.();
        prepared?.signal?.throwIfAborted();
        assertCurrent?.();
        onDispatch?.();
        return fetchWithRuntimeDispatcher(input, prepared);
      },
    });
    // Includes long-lived Activity bodies: release the pinned dispatcher only after consumption.
    return responseWithRelease(guarded.response, guarded.release);
  }

  function requestSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      ...[options.signal, signal].filter((value): value is AbortSignal => Boolean(value)),
      AbortSignal.timeout(30_000),
    ]);
  }

  async function refresh() {
    options.onTokenState?.("refreshing");
    try {
      if (!loadedRefreshToken) {
        refreshToken = (await options.loadRefreshToken?.()) ?? refreshToken;
        loadedRefreshToken = true;
      }
      if (pendingRefreshToken) {
        await options.saveRefreshToken(pendingRefreshToken);
        pendingRefreshToken = undefined;
      }
      const response = await fetcher(`${X_API_ORIGIN}/2/oauth2/token`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        signal: requestSignal(),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new XApiError(response.status, "token refresh");
      }
      const token = record(await readJson(response));
      if (!token || typeof token.access_token !== "string" || !token.access_token) {
        throw new Error("X API returned an invalid token response");
      }
      if (typeof token.refresh_token === "string" && token.refresh_token) {
        // Rotation is committed before any request uses the new access token.
        refreshToken = token.refresh_token;
        pendingRefreshToken = refreshToken;
        await options.saveRefreshToken(refreshToken);
        pendingRefreshToken = undefined;
      }
      accessToken = token.access_token;
      expiresAt =
        Date.now() +
        (typeof token.expires_in === "number" ? Math.max(0, token.expires_in - 30) : 7_170) * 1000;
      options.onTokenState?.("ready");
    } catch {
      accessToken = undefined;
      options.onTokenState?.("error");
      throw new Error("X token refresh failed; check the account credentials and token storage");
    }
  }

  async function ensureAccessToken() {
    if (accessToken && Date.now() < expiresAt) {
      return;
    }
    refreshTask ??= refresh().finally(() => {
      refreshTask = undefined;
    });
    await refreshTask;
  }

  type RequestOptions = {
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    appOnly?: boolean;
    stream?: boolean;
    assertActive?: XAssertActive;
    onDispatch?: () => void;
    onAuthenticationRejected?: () => void;
  };
  type Billing<T> = {
    maximum: number;
    actual: (value: unknown) => number;
    parse: (value: unknown) => T;
  };

  async function request<T>(
    path: string,
    params: RequestOptions & { billing: Billing<T> },
  ): Promise<T>;
  async function request(path: string, params?: RequestOptions): Promise<Response>;
  async function request<T>(
    path: string,
    params: RequestOptions & { billing?: Billing<T> } = {},
  ): Promise<T | Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reservation = params.billing
        ? await options.spend.reserve(params.billing.maximum)
        : undefined;
      let cost = 0;
      try {
        if (!params.appOnly) {
          await ensureAccessToken();
        }
        const token = params.appOnly ? options.bearerToken : accessToken;
        if (!token) {
          throw new Error("X Activity API requires a bearer token");
        }
        const signal = params.stream
          ? AbortSignal.any(
              [options.signal, params.signal].filter((value): value is AbortSignal =>
                Boolean(value),
              ),
            )
          : requestSignal(params.signal);
        signal.throwIfAborted();
        let response: Response;
        let authorityRejected = false;
        let authorityError: unknown;
        try {
          response = await fetcher(
            `${X_API_ORIGIN}${path}`,
            {
              method: params.method ?? "GET",
              redirect: "error",
              headers: {
                Authorization: `Bearer ${token}`,
                ...(params.body ? { "Content-Type": "application/json" } : {}),
              },
              ...(params.body ? { body: JSON.stringify(params.body) } : {}),
              signal,
            },
            params.assertActive
              ? async () => {
                  try {
                    const assertCurrent = await params.assertActive?.();
                    return () => {
                      try {
                        assertCurrent?.();
                      } catch (error) {
                        authorityRejected = true;
                        authorityError = error;
                        throw error;
                      }
                    };
                  } catch (error) {
                    authorityRejected = true;
                    authorityError = error;
                    throw error;
                  }
                }
              : undefined,
            () => {
              // From dispatch until a readable successful result or an explicit rejection,
              // the entire reservation remains charged, including lost responses and 5xx.
              cost = params.billing?.maximum ?? 0;
              params.onDispatch?.();
            },
          );
        } catch {
          if (authorityRejected) {
            throw authorityError;
          }
          signal.throwIfAborted();
          throw new Error("X API network request failed");
        }
        if (response.status >= 400 && response.status < 500) {
          cost = 0;
          if (params.billing) {
            const value = await readJson(response).catch(() => undefined);
            cost = params.billing.actual(value);
          } else {
            await response.body?.cancel();
          }
        }
        if (response.status === 401) {
          params.onAuthenticationRejected?.();
          if (!params.appOnly && attempt === 0) {
            if (accessToken === token) {
              accessToken = undefined;
            }
            continue;
          }
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new XApiError(response.status, path.split("?")[0] ?? path);
        }
        if (!params.billing) {
          return response;
        }
        const value = await readJson(response);
        const parsed = params.billing.parse(value);
        cost = params.billing.actual(value);
        return parsed;
      } finally {
        await reservation?.settle(cost);
      }
    }
    throw new Error("X user token was rejected after refresh");
  }

  async function page(
    path: string,
    query: Record<string, string | undefined>,
    maximumPosts: number,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      "tweet.fields": POST_FIELDS,
      // Reference IDs remain in tweet.fields; fetch their contents through bounded calls.
      expansions: "author_id",
      "user.fields": "username,name",
    });
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
    return request(`${path}?${params}`, {
      signal,
      billing: {
        maximum: maximumPosts * (X_POST_READ_MICRO_USD + X_USER_READ_MICRO_USD),
        actual: (value) => xReadCost(value, "posts"),
        parse: parsePage,
      },
    });
  }

  return {
    spend: options.spend,
    getMentions: (params: {
      userId: string;
      sinceId?: string;
      paginationToken?: string;
      signal?: AbortSignal;
    }) =>
      page(
        `/2/users/${encodeURIComponent(params.userId)}/mentions`,
        { since_id: params.sinceId, pagination_token: params.paginationToken, max_results: "10" },
        10,
        params.signal,
      ),
    getPosts: (ids: string[], signal?: AbortSignal) => {
      if (!ids.length || ids.length > 100) {
        throw new Error("X post lookup requires 1–100 post ids");
      }
      return page("/2/tweets", { ids: ids.join(",") }, ids.length, signal);
    },
    searchConversation: (params: {
      conversationId: string;
      maxPosts: number;
      nextToken?: string;
      signal?: AbortSignal;
    }) =>
      page(
        "/2/tweets/search/recent",
        {
          query: `conversation_id:${params.conversationId}`,
          next_token: params.nextToken,
          max_results: String(Math.max(10, Math.min(Math.floor(params.maxPosts), 100))),
          sort_order: "recency",
        },
        Math.max(10, Math.min(Math.floor(params.maxPosts), 100)),
        params.signal,
      ),
    async getUserByUsername(username: string, signal?: AbortSignal): Promise<XUser> {
      const user = await request(
        `/2/users/by/username/${encodeURIComponent(username.replace(/^@/, ""))}?user.fields=id,username,name`,
        {
          signal,
          billing: {
            maximum: X_USER_READ_MICRO_USD,
            actual: (value) => xReadCost(value, "users"),
            parse: (value) => {
              if (record(value)?.data === undefined) {
                return undefined;
              }
              const resolved = parseUser(record(value)?.data);
              if (!resolved) {
                throw new Error("X API returned no matching user");
              }
              return resolved;
            },
          },
        },
      );
      if (!user) {
        throw new Error("X API returned no matching user");
      }
      return user;
    },
    async reply(params: {
      text: string;
      inReplyToId: string;
      signal?: AbortSignal;
      assertActive?: XAssertActive;
    }): Promise<string> {
      let dispatched = false;
      try {
        params.signal?.throwIfAborted();
        return await request("/2/tweets", {
          billing: {
            maximum: xReplyCost(params.text),
            actual: (value) => (record(record(value)?.data)?.id ? xReplyCost(params.text) : 0),
            parse: (value) => {
              const id = record(record(value)?.data)?.id;
              if (typeof id !== "string" || !/^\d+$/.test(id)) {
                throw new Error("X API returned no reply id; delivery outcome is unknown");
              }
              return id;
            },
          },
          method: "POST",
          body: { text: params.text, reply: { in_reply_to_tweet_id: params.inReplyToId } },
          signal: params.signal,
          assertActive: params.assertActive,
          onDispatch: () => {
            dispatched = true;
          },
          // An explicit 401 proves the attempted post was rejected, even if its refresh fails.
          onAuthenticationRejected: () => {
            dispatched = false;
          },
        });
      } catch (cause) {
        if (cause instanceof PlatformMessageNotDispatchedError) {
          throw cause;
        }
        if (cause instanceof XBudgetExceededError) {
          throw new PlatformMessageNotDispatchedError(cause.message, { cause, retryable: false });
        }
        if (cause instanceof XApiError && cause.status < 500) {
          // A 4xx rejection proves X created no post: rate limits are safe to retry,
          // other client rejections are permanent. 5xx stays ambiguous (the post may exist).
          throw new PlatformMessageNotDispatchedError(cause.message, {
            cause,
            retryable: cause.status === 429,
          });
        }
        if (dispatched) {
          throw cause;
        }
        throw new PlatformMessageNotDispatchedError(
          cause instanceof Error ? cause.message : "X reply failed before dispatch",
          { cause, retryable: !params.signal?.aborted && !options.signal?.aborted },
        );
      }
    },
    async ensureActivitySubscriptions(userId: string, signal?: AbortSignal) {
      const response = await request("/2/activity/subscriptions", { appOnly: true, signal });
      const data = record(await readJson(response))?.data;
      const subscriptions = Array.isArray(data) ? data : [];
      if (
        subscriptions.some((value) => {
          const subscription = record(value);
          return (
            subscription?.event_type === "post.mention.create" &&
            record(subscription.filter)?.user_id === userId
          );
        })
      ) {
        return;
      }
      const created = await request("/2/activity/subscriptions", {
        method: "POST",
        body: { event_type: "post.mention.create", filter: { user_id: userId } },
        appOnly: true,
        signal,
      });
      await created.body?.cancel();
    },
    openActivityStream: (signal: AbortSignal) =>
      request("/2/activity/stream", { appOnly: true, stream: true, signal }),
  };
}
