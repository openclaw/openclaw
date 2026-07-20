// Microsoft Graph HTTP client for the mail-wake plugin. Every request goes
// through the SSRF-guarded fetch with an audit context and a bounded timeout,
// and the guard release runs in finally.
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { GraphTokenProvider } from "./graph-auth.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_REQUEST_TIMEOUT_MS = 15_000;
const MESSAGE_SELECT_FIELDS = "id,subject,receivedDateTime,internetMessageId";

/**
 * Sanitized Graph request failure. The `.message` carries only op + status +
 * (safe, enum-like) Graph error code — never the raw response body, message, or
 * request path, which can embed URLs, tokens, or mailbox/message identifiers.
 * `expirationMaxMinutes` is a bare integer parsed out of the Graph error text
 * (the tenant's real expiration ceiling) and is therefore safe to surface.
 */
export class GraphRequestError extends Error {
  override name = "GraphRequestError";
  readonly op: string;
  readonly status: number | string;
  readonly graphErrorCode?: string;
  readonly expirationMaxMinutes?: number;

  constructor(params: {
    op: string;
    status: number | string;
    graphErrorCode?: string;
    expirationMaxMinutes?: number;
  }) {
    super(
      `Graph request failed: op=${params.op} status=${String(params.status)} code=${params.graphErrorCode ?? "?"}`,
    );
    this.op = params.op;
    this.status = params.status;
    if (params.graphErrorCode !== undefined) {
      this.graphErrorCode = params.graphErrorCode;
    }
    if (params.expirationMaxMinutes !== undefined) {
      this.expirationMaxMinutes = params.expirationMaxMinutes;
    }
  }
}

export type GraphSubscription = {
  id: string;
  expirationDateTime?: string;
};

export type GraphSubscriptionSummary = {
  id: string;
  notificationUrl?: string;
};

export type GraphMessageSummary = {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  internetMessageId?: string;
};

export type GraphClient = {
  createSubscription: (params: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    lifecycleNotificationUrl?: string;
    expirationDateTime: string;
    clientState: string;
  }) => Promise<GraphSubscription>;
  renewSubscription: (params: {
    subscriptionId: string;
    expirationDateTime: string;
    notificationUrl?: string;
  }) => Promise<GraphSubscription | null>;
  deleteSubscription: (params: { subscriptionId: string }) => Promise<void>;
  listSubscriptions: () => Promise<GraphSubscriptionSummary[]>;
  fetchMessage: (params: {
    user: string;
    messageId: string;
  }) => Promise<GraphMessageSummary | null>;
};

export function createGraphClient(params: { tokenProvider: GraphTokenProvider }): GraphClient {
  const request = async (requestParams: {
    path: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    allowNotFound?: boolean;
    /** Fixed operation code used in errors — Graph paths embed mailbox and
     * message identifiers and must never appear in thrown errors or logs. */
    op:
      | "create_subscription"
      | "renew_subscription"
      | "delete_subscription"
      | "list_subscriptions"
      | "fetch_message";
  }): Promise<{ status: number; json: unknown }> => {
    const token = await params.tokenProvider.getAccessToken();
    const hasBody = requestParams.body !== undefined;
    const { response, release } = await fetchWithSsrFGuard({
      url: `${GRAPH_ROOT}${requestParams.path}`,
      init: {
        method: requestParams.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(requestParams.body) } : {}),
      },
      auditContext: "msgraph-mail-wake.graph",
      timeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
    });
    try {
      if (requestParams.allowNotFound && response.status === 404) {
        return { status: 404, json: undefined };
      }
      if (!response.ok) {
        // Never include the response body or the request path in the error:
        // Graph error payloads can echo request material, and paths embed
        // mailbox/message identifiers. Best-effort extract ONLY provably-safe
        // fields from the error body: the enum-like `error.code`, and — when the
        // message names an expiration ceiling — the bare integer minutes value.
        let graphErrorCode: string | undefined;
        let expirationMaxMinutes: number | undefined;
        try {
          const errorBody = (await response.json()) as
            | { error?: { code?: unknown; message?: unknown } }
            | undefined;
          const graphError = errorBody?.error;
          // Only accept an enum-like Graph error code (e.g. `Forbidden`,
          // `ExtensionError`, `InvalidRequest`). A crafted/unexpected `code`
          // could otherwise inject arbitrary text into the error message and
          // logs; anything not matching this bounded shape is treated as absent.
          if (
            typeof graphError?.code === "string" &&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(graphError.code)
          ) {
            graphErrorCode = graphError.code;
          }
          if (typeof graphError?.message === "string") {
            const match = /can only be (\d+) minutes in the future/i.exec(graphError.message);
            if (match?.[1]) {
              expirationMaxMinutes = Number.parseInt(match[1], 10);
            }
          }
        } catch {
          // Non-JSON or unreadable body: fall through with no extra fields.
        }
        throw new GraphRequestError({
          op: requestParams.op,
          status: response.status,
          ...(graphErrorCode !== undefined ? { graphErrorCode } : {}),
          ...(expirationMaxMinutes !== undefined ? { expirationMaxMinutes } : {}),
        });
      }
      if (response.status === 204 || requestParams.method === "DELETE") {
        return { status: response.status, json: undefined };
      }
      return { status: response.status, json: (await response.json()) as unknown };
    } finally {
      await release();
    }
  };

  return {
    createSubscription: async (subscriptionParams) => {
      const { json } = await request({
        path: "/subscriptions",
        method: "POST",
        op: "create_subscription",
        body: {
          changeType: subscriptionParams.changeType,
          notificationUrl: subscriptionParams.notificationUrl,
          ...(subscriptionParams.lifecycleNotificationUrl
            ? { lifecycleNotificationUrl: subscriptionParams.lifecycleNotificationUrl }
            : {}),
          resource: subscriptionParams.resource,
          expirationDateTime: subscriptionParams.expirationDateTime,
          clientState: subscriptionParams.clientState,
        },
      });
      const subscription = json as GraphSubscription | undefined;
      if (!subscription?.id) {
        throw new GraphRequestError({ op: "create_subscription", status: "no_id" });
      }
      return subscription;
    },
    renewSubscription: async (renewParams) => {
      const result = await request({
        path: `/subscriptions/${encodeURIComponent(renewParams.subscriptionId)}`,
        method: "PATCH",
        op: "renew_subscription",
        body: {
          expirationDateTime: renewParams.expirationDateTime,
          ...(renewParams.notificationUrl ? { notificationUrl: renewParams.notificationUrl } : {}),
        },
        allowNotFound: true,
      });
      if (result.status === 404) {
        return null;
      }
      return (result.json as GraphSubscription | undefined) ?? null;
    },
    deleteSubscription: async (deleteParams) => {
      await request({
        path: `/subscriptions/${encodeURIComponent(deleteParams.subscriptionId)}`,
        method: "DELETE",
        op: "delete_subscription",
        allowNotFound: true,
      });
    },
    listSubscriptions: async () => {
      const { json } = await request({
        path: "/subscriptions",
        method: "GET",
        op: "list_subscriptions",
      });
      // Return only the identity/URL fields we need for orphan reconciliation;
      // never surface the full Graph payload (it can carry other tenants' data).
      const value = (json as { value?: unknown } | undefined)?.value;
      if (!Array.isArray(value)) {
        return [];
      }
      const summaries: GraphSubscriptionSummary[] = [];
      for (const raw of value) {
        const entry = raw as { id?: unknown; notificationUrl?: unknown } | null;
        if (typeof entry?.id !== "string") {
          continue;
        }
        const summary: GraphSubscriptionSummary = { id: entry.id };
        if (typeof entry.notificationUrl === "string") {
          summary.notificationUrl = entry.notificationUrl;
        }
        summaries.push(summary);
      }
      return summaries;
    },
    fetchMessage: async (fetchParams) => {
      const result = await request({
        path:
          `/users/${encodeURIComponent(fetchParams.user)}` +
          `/messages/${encodeURIComponent(fetchParams.messageId)}` +
          `?$select=${MESSAGE_SELECT_FIELDS}`,
        method: "GET",
        op: "fetch_message",
        allowNotFound: true,
      });
      const message = result.json as GraphMessageSummary | undefined;
      if (result.status === 404 || !message?.id) {
        return null;
      }
      return message;
    },
  };
}
