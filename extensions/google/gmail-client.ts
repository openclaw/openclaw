import {
  buildGmailApiUrl,
  buildGmailDraftCreateRequest,
  buildGmailEncodedMessageRequest,
  buildGmailSearchQuery,
} from "./gmail-api.js";
import { refreshGmailAccessToken, type GmailOAuthCredentials } from "./gmail-oauth.js";
import type {
  GmailDraft,
  GmailDraftMessageInput,
  GmailListMessagesResponse,
  GmailMessage,
  GmailSearchParams,
  GmailSentMessage,
  GmailThread,
} from "./gmail-types.js";
import { fetchWithTimeout } from "./oauth.http.js";

export type GmailClientAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type GmailClient = {
  auth: GmailClientAuth;
  listMessages: (params?: {
    maxResults?: number;
    pageToken?: string;
    query?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
  }) => Promise<GmailListMessagesResponse>;
  searchMessages: (
    params?: GmailSearchParams & { maxResults?: number; pageToken?: string },
  ) => Promise<GmailListMessagesResponse>;
  getMessage: (
    id: string,
    format?: "full" | "metadata" | "minimal" | "raw",
  ) => Promise<GmailMessage>;
  getThread: (id: string, format?: "full" | "metadata" | "minimal") => Promise<GmailThread>;
  createDraft: (input: GmailDraftMessageInput) => Promise<GmailDraft>;
  sendMessage: (input: GmailDraftMessageInput) => Promise<GmailSentMessage>;
};

type GmailClientOptions = {
  auth: GmailClientAuth;
  fetchFn?: typeof fetchWithTimeout;
  refreshTokenFn?: (params: { refreshToken: string }) => Promise<GmailOAuthCredentials>;
  onTokenRefresh?: (cred: GmailOAuthCredentials) => Promise<void> | void;
};

async function parseJsonResponse<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`Gmail ${action} failed: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export function createGmailClient(options: GmailClientOptions): GmailClient {
  let auth = { ...options.auth };
  const fetchFn = options.fetchFn ?? fetchWithTimeout;
  const refreshTokenFn = options.refreshTokenFn ?? refreshGmailAccessToken;

  async function resolveAccessToken(): Promise<string> {
    const now = Date.now();
    if (!auth.expiresAt || auth.expiresAt > now || !auth.refreshToken) {
      return auth.accessToken;
    }
    const refreshed = await refreshTokenFn({ refreshToken: auth.refreshToken });
    auth = {
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
    };
    await options.onTokenRefresh?.(refreshed);
    return auth.accessToken;
  }

  async function gmailFetch<T>(path: string, init: RequestInit = {}, action: string): Promise<T> {
    const token = await resolveAccessToken();
    const response = await fetchFn(path, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    return await parseJsonResponse<T>(response, action);
  }

  return {
    get auth() {
      return auth;
    },
    listMessages: async (params) =>
      await gmailFetch<GmailListMessagesResponse>(
        buildGmailApiUrl("/messages", {
          maxResults: params?.maxResults,
          pageToken: params?.pageToken,
          q: params?.query,
          labelIds: params?.labelIds?.join(","),
          includeSpamTrash: params?.includeSpamTrash,
        }),
        undefined,
        "list messages",
      ),
    searchMessages: async (params) =>
      await gmailFetch<GmailListMessagesResponse>(
        buildGmailApiUrl("/messages", {
          maxResults: params?.maxResults,
          pageToken: params?.pageToken,
          q: buildGmailSearchQuery(params ?? {}),
        }),
        undefined,
        "search messages",
      ),
    getMessage: async (id, format = "full") =>
      await gmailFetch<GmailMessage>(
        buildGmailApiUrl(`/messages/${encodeURIComponent(id)}`, { format }),
        undefined,
        "get message",
      ),
    getThread: async (id, format = "full") =>
      await gmailFetch<GmailThread>(
        buildGmailApiUrl(`/threads/${encodeURIComponent(id)}`, { format }),
        undefined,
        "get thread",
      ),
    createDraft: async (input) =>
      await gmailFetch<GmailDraft>(
        buildGmailApiUrl("/drafts"),
        {
          method: "POST",
          body: JSON.stringify(buildGmailDraftCreateRequest(input)),
        },
        "create draft",
      ),
    sendMessage: async (input) =>
      await gmailFetch<GmailSentMessage>(
        buildGmailApiUrl("/messages/send"),
        {
          method: "POST",
          body: JSON.stringify(buildGmailEncodedMessageRequest(input)),
        },
        "send message",
      ),
  };
}
