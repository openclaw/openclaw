import { createHash } from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE = "notify-subscribers";
export const DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE = "notify-seen-requests";
export const DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES = 1024;
export const DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES = 4096;
export const DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS = 24 * 60 * 60 * 1000;

export type NotifySubscription = {
  to: string;
  accountId?: string;
  messageThreadId?: string | number;
  mode: "persistent" | "once";
  addedAtMs: number;
  /** Makes repeated writes in the same millisecond distinct to store comparisons. */
  armId?: string;
};

export type NotifySeenRequest = {
  requestId: string;
  notifiedAtMs: number;
};

function normalizeNotifyThreadKey(messageThreadId?: string | number): string {
  if (typeof messageThreadId === "number" && Number.isFinite(messageThreadId)) {
    return String(Math.trunc(messageThreadId));
  }
  if (typeof messageThreadId !== "string") {
    return "";
  }
  const normalized = normalizeOptionalString(messageThreadId);
  if (!normalized) {
    return "";
  }
  if (!/^-?\d+$/u.test(normalized)) {
    return normalized;
  }
  try {
    return BigInt(normalized).toString();
  } catch {
    return normalized;
  }
}

function hashStoreKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function notifySubscriberStoreKey(
  subscriber: Pick<NotifySubscription, "to" | "accountId" | "messageThreadId">,
): string {
  return hashStoreKey(
    JSON.stringify([
      subscriber.to,
      subscriber.accountId ?? "",
      normalizeNotifyThreadKey(subscriber.messageThreadId),
    ]),
  );
}

export function notifyRequestStoreKey(requestId: string): string {
  return hashStoreKey(requestId);
}
