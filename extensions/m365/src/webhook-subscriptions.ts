import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  safeEqualSecret,
  type WebhookInFlightLimiter,
} from "../runtime-api.js";
import type { M365ResolvedAccountConfig, M365ResolvedPluginConfig } from "./config.js";
import { encodeGraphPathSegment, type M365GraphClient } from "./graph-client.js";

export type M365GraphSubscriptionPayload = {
  changeType: string;
  notificationUrl: string;
  resource: string;
  expirationDateTime: string;
  clientState: string;
};

export type M365GraphSubscription = {
  id: string;
  resource?: string;
  expirationDateTime?: string;
};

export type M365MailNotification = {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  messageId?: string;
  tenantId?: string;
};

type GraphNotificationEnvelope = {
  value?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expirationIso(params: { now?: Date; minutes: number }): string {
  const nowMs = params.now?.getTime() ?? Date.now();
  return new Date(nowMs + params.minutes * 60 * 1000).toISOString();
}

export function buildM365MailSubscriptionPayload(params: {
  account: M365ResolvedAccountConfig;
  config: M365ResolvedPluginConfig;
  notificationUrl: string;
  clientState: string;
  changeType?: string;
  now?: Date;
}): M365GraphSubscriptionPayload {
  return {
    changeType: params.changeType ?? "created,updated",
    notificationUrl: params.notificationUrl,
    resource: `users/${encodeGraphPathSegment(
      params.account.mailboxUserId,
    )}/mailFolders/${encodeGraphPathSegment(params.account.folder)}/messages`,
    expirationDateTime: expirationIso({
      now: params.now,
      minutes: params.config.webhook.expirationMinutes,
    }),
    clientState: params.clientState,
  };
}

export async function createM365MailSubscription(params: {
  client: M365GraphClient;
  payload: M365GraphSubscriptionPayload;
}): Promise<M365GraphSubscription> {
  const response = await params.client.requestJson("/subscriptions", {
    method: "POST",
    body: params.payload,
  });
  if (!isRecord(response) || typeof response.id !== "string") {
    throw new Error("Microsoft Graph subscription response missing id");
  }
  return {
    id: response.id,
    resource: stringValue(response.resource),
    expirationDateTime: stringValue(response.expirationDateTime),
  };
}

export async function renewM365Subscription(params: {
  client: M365GraphClient;
  subscriptionId: string;
  expirationDateTime: string;
}): Promise<M365GraphSubscription> {
  const response = await params.client.requestJson(
    `/subscriptions/${encodeGraphPathSegment(params.subscriptionId)}`,
    {
      method: "PATCH",
      body: {
        expirationDateTime: params.expirationDateTime,
      },
    },
  );
  if (!isRecord(response) || typeof response.id !== "string") {
    throw new Error("Microsoft Graph subscription renewal response missing id");
  }
  return {
    id: response.id,
    resource: stringValue(response.resource),
    expirationDateTime: stringValue(response.expirationDateTime),
  };
}

export function parseM365MailNotifications(payload: unknown): M365MailNotification[] {
  if (!isRecord(payload)) {
    return [];
  }
  const envelope = payload as GraphNotificationEnvelope;
  if (!Array.isArray(envelope.value)) {
    return [];
  }
  const notifications: M365MailNotification[] = [];
  for (const entry of envelope.value) {
    if (!isRecord(entry)) {
      continue;
    }
    const subscriptionId = stringValue(entry.subscriptionId);
    if (!subscriptionId) {
      continue;
    }
    const resourceData = isRecord(entry.resourceData) ? entry.resourceData : {};
    notifications.push({
      subscriptionId,
      clientState: stringValue(entry.clientState),
      changeType: stringValue(entry.changeType),
      resource: stringValue(entry.resource),
      messageId: stringValue(resourceData.id),
      tenantId: stringValue(entry.tenantId),
    });
  }
  return notifications;
}

export function createM365WebhookHandler(params: {
  config: M365ResolvedPluginConfig;
  onNotifications: (notifications: M365MailNotification[]) => Promise<void> | void;
  inFlightLimiter?: WebhookInFlightLimiter;
}) {
  const inFlightLimiter = params.inFlightLimiter ?? createWebhookInFlightLimiter();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const validationToken = url.searchParams.get("validationToken");
    if (validationToken) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(validationToken);
      return true;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    const key = `${url.pathname}:${req.socket.remoteAddress ?? "unknown"}`;
    if (!inFlightLimiter.tryAcquire(key)) {
      res.statusCode = 429;
      res.end("Too Many Requests");
      return true;
    }
    try {
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: params.config.webhook.maxBodyBytes,
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "Invalid Microsoft Graph notification payload",
      });
      if (!body.ok) {
        return true;
      }
      const notifications = parseM365MailNotifications(body.value);
      const expectedClientState = params.config.webhook.clientState;
      const accepted = expectedClientState
        ? notifications.filter((notification) =>
            safeEqualSecret(notification.clientState ?? "", expectedClientState),
          )
        : notifications;
      if (expectedClientState && notifications.length > 0 && accepted.length === 0) {
        res.statusCode = 401;
        res.end("Invalid clientState");
        return true;
      }
      await params.onNotifications(accepted);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, received: accepted.length }));
      return true;
    } finally {
      inFlightLimiter.release(key);
    }
  };
}
