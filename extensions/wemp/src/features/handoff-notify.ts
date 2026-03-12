import { parsePositiveInt, resolveEnvString, postWebhookWithRetry } from "../notify-utils.js";
import { readJsonFile, writeJsonFile } from "../storage.js";
import type { WempHandoffTicketWebhookConfig } from "../types.js";

const HANDOFF_NOTIFY_FILE = "handoff-notify.json";
const DEFAULT_NOTIFY_TIMEOUT_MS = 3_000;
const DEFAULT_NOTIFY_RETRIES = 1;
const DEFAULT_NOTIFY_BATCH_SIZE = 20;

export interface HandoffNotificationDeliveryTarget {
  endpoint: string;
  token?: string;
}

export interface HandoffNotificationDeliveryTargets {
  ticket?: HandoffNotificationDeliveryTarget;
}

export interface HandoffNotification {
  id: string;
  type: "activated" | "resumed";
  accountId: string;
  openId: string;
  at: number;
  contact?: string;
  expireAt?: number;
  reason?: string;
  deliveries?: HandoffNotificationDeliveryTargets;
}

export interface HandoffNotifyFlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  remaining: number;
  skipped: boolean;
}

const notifyQueue = readJsonFile<HandoffNotification[]>(HANDOFF_NOTIFY_FILE, []);

function persistNotifyQueue(): void {
  writeJsonFile(HANDOFF_NOTIFY_FILE, notifyQueue);
}

function notifyEndpoint(): string {
  return resolveEnvString(
    "WEMP_HANDOFF_NOTIFY_ENDPOINT",
    "WEMP_HANDOFF_WEBHOOK",
    "WEMP_HANDOFF_ENDPOINT",
  );
}

function notifyAuthToken(): string {
  return resolveEnvString("WEMP_HANDOFF_NOTIFY_TOKEN", "WEMP_HANDOFF_API_KEY");
}

function parseTicketEvents(raw: string | undefined): Array<"activated" | "resumed"> {
  const normalized = String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const events = normalized.filter(
    (event): event is "activated" | "resumed" => event === "activated" || event === "resumed",
  );
  return events.length ? Array.from(new Set(events)) : ["activated"];
}

function ticketEndpoint(): string {
  return resolveEnvString("WEMP_HANDOFF_TICKET_ENDPOINT", "WEMP_HANDOFF_TICKET_WEBHOOK");
}

function ticketAuthToken(): string {
  return resolveEnvString("WEMP_HANDOFF_TICKET_TOKEN", "WEMP_HANDOFF_TICKET_API_KEY");
}

function ticketEvents(): Array<"activated" | "resumed"> {
  return parseTicketEvents(process.env.WEMP_HANDOFF_TICKET_EVENTS);
}

async function postHandoffNotificationWithRetry(
  endpoint: string,
  event: string,
  authToken: string | undefined,
  notification: HandoffNotification,
  timeoutMs: number,
  retries: number,
): Promise<boolean> {
  return postWebhookWithRetry({
    endpoint,
    payload: { channel: "wemp", event, data: notification },
    authToken: authToken || undefined,
    timeoutMs,
    retries,
  });
}

export function resolveHandoffTicketDelivery(
  type: HandoffNotification["type"],
  cfg?: WempHandoffTicketWebhookConfig | null,
): HandoffNotificationDeliveryTarget | null {
  const configEnabled = cfg?.enabled === true;
  const configEvents = Array.isArray(cfg?.events) ? cfg.events : [];
  if (configEnabled) {
    const endpoint = String(cfg?.endpoint || "").trim();
    if (endpoint && (configEvents.length === 0 || configEvents.includes(type))) {
      const token = String(cfg?.token || "").trim();
      return {
        endpoint,
        ...(token ? { token } : {}),
      };
    }
  }

  const endpoint = ticketEndpoint();
  if (!endpoint) return null;
  if (!ticketEvents().includes(type)) return null;
  const token = ticketAuthToken();
  return {
    endpoint,
    ...(token ? { token } : {}),
  };
}

export function emitHandoffNotification(notification: HandoffNotification): void {
  notifyQueue.push(notification);
  if (notifyQueue.length > 1000) {
    notifyQueue.splice(0, notifyQueue.length - 1000);
  }
  persistNotifyQueue();
}

export function consumeHandoffNotifications(limit = 20): HandoffNotification[] {
  const count = Math.max(1, Math.floor(limit));
  const picked = notifyQueue.splice(0, count);
  persistNotifyQueue();
  return picked;
}

export async function flushHandoffNotificationsToExternal(
  limit = DEFAULT_NOTIFY_BATCH_SIZE,
): Promise<HandoffNotifyFlushResult> {
  const endpoint = notifyEndpoint();
  const authToken = notifyAuthToken();
  if (!endpoint && notifyQueue.every((item) => !item.deliveries?.ticket) && !ticketEndpoint()) {
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      remaining: notifyQueue.length,
      skipped: true,
    };
  }

  const timeoutMs = parsePositiveInt(
    process.env.WEMP_HANDOFF_NOTIFY_TIMEOUT_MS,
    DEFAULT_NOTIFY_TIMEOUT_MS,
    500,
  );
  const retries = parsePositiveInt(
    process.env.WEMP_HANDOFF_NOTIFY_RETRIES,
    DEFAULT_NOTIFY_RETRIES,
    0,
  );
  const maxBatch = Math.max(1, Math.floor(limit || DEFAULT_NOTIFY_BATCH_SIZE));

  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  while (attempted < maxBatch && notifyQueue.length > 0) {
    const notification = notifyQueue[0]!;
    attempted += 1;
    const destinations: Array<{ endpoint: string; event: string; token?: string }> = [];
    if (endpoint) {
      destinations.push({
        endpoint,
        event: "handoff_notification",
        ...(authToken ? { token: authToken } : {}),
      });
    }
    const ticketDelivery =
      notification.deliveries?.ticket || resolveHandoffTicketDelivery(notification.type, null);
    if (ticketDelivery?.endpoint) {
      destinations.push({
        endpoint: ticketDelivery.endpoint,
        event: "handoff_ticket",
        ...(ticketDelivery.token ? { token: ticketDelivery.token } : {}),
      });
    }
    if (destinations.length === 0) {
      delivered += 1;
      notifyQueue.shift();
      persistNotifyQueue();
      continue;
    }
    let ok = true;
    for (const destination of destinations) {
      const deliveredOk = await postHandoffNotificationWithRetry(
        destination.endpoint,
        destination.event,
        destination.token,
        notification,
        timeoutMs,
        retries,
      );
      if (!deliveredOk) {
        ok = false;
        break;
      }
    }
    if (ok) {
      delivered += 1;
      notifyQueue.shift();
      persistNotifyQueue();
      continue;
    }
    failed += 1;
    break;
  }

  return {
    attempted,
    delivered,
    failed,
    remaining: notifyQueue.length,
    skipped: false,
  };
}
