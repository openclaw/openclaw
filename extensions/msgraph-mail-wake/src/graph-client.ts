// Microsoft Graph HTTP client for the mail-wake plugin. Every request goes
// through the SSRF-guarded fetch with an audit context and a bounded timeout,
// and the guard release runs in finally.
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { GraphTokenProvider } from "./graph-auth.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_REQUEST_TIMEOUT_MS = 15_000;
const MESSAGE_SELECT_FIELDS = "id,subject,receivedDateTime,internetMessageId";

export type GraphSubscription = {
  id: string;
  expirationDateTime?: string;
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
    op: "create_subscription" | "renew_subscription" | "delete_subscription" | "fetch_message";
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
        // mailbox/message identifiers.
        throw new Error(`Graph request failed: op=${requestParams.op} status=${response.status}`);
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
        throw new Error("Graph request failed: op=create_subscription status=no_id");
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
