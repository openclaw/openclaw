import { randomUUID } from "node:crypto";
import { listDevicePairing } from "openclaw/plugin-sdk/device-bootstrap";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginServiceSchedulerV1,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifyRequestStoreKey,
  notifySubscriberStoreKey,
  type NotifySeenRequest,
  type NotifySubscription,
} from "./notify-state.js";

const NOTIFY_POLL_INTERVAL_MS = 10_000;

// Gateway services and workspace command registries have distinct APIs but share these stores.
let notifyStateRevision = 0;
let pendingNotifyWrites = 0;
const inactiveNotifierRevisions = new WeakMap<OpenClawPluginApi, number>();

async function writeNotifyState<T>(write: () => Promise<T>): Promise<T> {
  notifyStateRevision++;
  pendingNotifyWrites++;
  try {
    return await write();
  } finally {
    // Failed replies can follow durable writes; the next poll must reconcile either outcome.
    notifyStateRevision++;
    pendingNotifyWrites--;
  }
}

type PendingPairingRequest = Pick<
  Awaited<ReturnType<typeof listDevicePairing>>["pending"][number],
  "requestId" | "deviceId" | "displayName" | "platform" | "role" | "roles" | "scopes" | "remoteIp"
> & { ts?: number };

function formatStringList(values?: readonly string[]): string {
  return normalizeTrimmedStringList(values).join(", ") || "none";
}

function formatRoleList(request: PendingPairingRequest): string {
  return normalizeOptionalString(request.role) ?? formatStringList(request.roles);
}

export function formatPendingRequests(pending: PendingPairingRequest[]): string {
  if (pending.length === 0) {
    return "No pending device pairing requests.";
  }
  const lines: string[] = ["Pending device pairing requests:"];
  for (const req of pending) {
    const label = normalizeOptionalString(req.displayName) || req.deviceId;
    const platform = normalizeOptionalString(req.platform);
    const ip = normalizeOptionalString(req.remoteIp);
    const parts = [
      `- ${req.requestId}`,
      label ? `name=${label}` : null,
      platform ? `platform=${platform}` : null,
      `role=${formatRoleList(req)}`,
      `scopes=${formatStringList(req.scopes)}`,
      ip ? `ip=${ip}` : null,
    ].filter(Boolean);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

type NotifySubscriberStore = PluginStateKeyedStore<NotifySubscription> & {
  observe: NonNullable<PluginStateKeyedStore<NotifySubscription>["observe"]>;
  compareAndApply: NonNullable<PluginStateKeyedStore<NotifySubscription>["compareAndApply"]>;
};

function openNotifySubscriberStore(api: OpenClawPluginApi): NotifySubscriberStore {
  const store = api.runtime.state.openKeyedStore<NotifySubscription>({
    namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
    maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  });
  if (!store.observe || !store.compareAndApply) {
    throw new Error(
      "device-pair notify requires a runtime with atomic plugin state compare-and-apply support",
    );
  }
  return store as NotifySubscriberStore;
}

function openNotifySeenRequestStore(
  api: OpenClawPluginApi,
): PluginStateKeyedStore<NotifySeenRequest> {
  return api.runtime.state.openKeyedStore<NotifySeenRequest>({
    namespace: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
    maxEntries: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
    defaultTtlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  });
}

type NotifyTarget = Pick<NotifySubscription, "to" | "accountId" | "messageThreadId">;

function resolveNotifyTarget(ctx: NotifyCommandContext): NotifyTarget | null {
  const to =
    normalizeOptionalString(ctx.senderId) ||
    normalizeOptionalString(ctx.from) ||
    normalizeOptionalString(ctx.to) ||
    "";
  if (!to) {
    return null;
  }
  return {
    to,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(ctx.messageThreadId != null ? { messageThreadId: ctx.messageThreadId } : {}),
  };
}

function nextNotifySubscription(
  target: NotifyTarget,
  mode: NotifySubscription["mode"],
): NotifySubscription {
  return {
    ...target,
    mode,
    addedAtMs: Date.now(),
    armId: randomUUID(),
  };
}

async function registerNotifySubscriber(params: {
  api: OpenClawPluginApi;
  target: NotifyTarget;
  mode: NotifySubscription["mode"];
  refresh: boolean;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const assertCurrent = params.assertCurrent;
  const store = openNotifySubscriberStore(params.api);
  const key = notifySubscriberStoreKey(params.target);
  const current = await store.lookup(key);
  if (!params.refresh && current?.mode === params.mode) {
    return false;
  }
  await writeNotifyState(() =>
    store.register(key, nextNotifySubscription(params.target, params.mode), { assertCurrent }),
  );
  return true;
}

function buildPairingRequestNotificationText(request: PendingPairingRequest): string {
  const label = normalizeOptionalString(request.displayName) || request.deviceId;
  const platform = normalizeOptionalString(request.platform);
  const ip = normalizeOptionalString(request.remoteIp);
  const role = formatRoleList(request);
  const scopes = formatStringList(request.scopes);
  const lines = [
    "📲 New device pairing request",
    `ID: ${request.requestId}`,
    `Name: ${label}`,
    ...(platform ? [`Platform: ${platform}`] : []),
    `Role: ${role}`,
    `Scopes: ${scopes}`,
    ...(ip ? [`IP: ${ip}`] : []),
    "",
    `Approve: /pair approve ${request.requestId}`,
    "List pending: /pair pending",
  ];
  return lines.join("\n");
}

function requestTimestampMs(request: PendingPairingRequest): number | null {
  if (typeof request.ts !== "number" || !Number.isFinite(request.ts)) {
    return null;
  }
  const ts = Math.trunc(request.ts);
  return ts > 0 ? ts : null;
}

function shouldNotifySubscriberForRequest(
  subscriber: NotifySubscription,
  request: PendingPairingRequest,
): boolean {
  if (subscriber.mode !== "once") {
    return true;
  }
  const ts = requestTimestampMs(request);
  // One-shot subscriptions should only notify for new requests created after arming.
  if (ts == null) {
    return false;
  }
  return ts >= subscriber.addedAtMs;
}

async function notifyPendingPairingRequests(params: { api: OpenClawPluginApi }): Promise<void> {
  if (inactiveNotifierRevisions.get(params.api) === notifyStateRevision) {
    return;
  }
  const revision = notifyStateRevision;
  const subscriberStore = openNotifySubscriberStore(params.api);
  const seenRequestStore = openNotifySeenRequestStore(params.api);
  const [subscriberEntries, seenRequestEntries] = await Promise.all([
    subscriberStore.entries(),
    seenRequestStore.entries(),
  ]);
  if (subscriberEntries.length === 0 && seenRequestEntries.length === 0) {
    if (notifyStateRevision === revision && pendingNotifyWrites === 0) {
      inactiveNotifierRevisions.set(params.api, revision);
    }
    return;
  }
  const pairing = await listDevicePairing();
  const subscribers = subscriberEntries.toSorted((a, b) => a.value.addedAtMs - b.value.addedAtMs);
  const pending: PendingPairingRequest[] = pairing.pending;
  const now = Date.now();
  const pendingIds = new Set(pending.map((entry) => entry.requestId));
  const notifiedRequestIds = new Set<string>();

  for (const entry of seenRequestEntries) {
    const requestId = normalizeOptionalString(entry.value.requestId);
    const notifiedAtMs = entry.value.notifiedAtMs;
    if (
      !requestId ||
      !Number.isFinite(notifiedAtMs) ||
      notifiedAtMs <= 0 ||
      !pendingIds.has(requestId) ||
      now - notifiedAtMs > DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS
    ) {
      await writeNotifyState(() => seenRequestStore.delete(entry.key));
      continue;
    }
    notifiedRequestIds.add(requestId);
  }

  if (subscribers.length > 0) {
    const deliveredOneShots = new Set<string>();
    for (const request of pending) {
      if (notifiedRequestIds.has(request.requestId)) {
        continue;
      }

      const text = buildPairingRequestNotificationText(request);
      let delivered = false;
      for (const entry of subscribers) {
        if (deliveredOneShots.has(entry.key)) {
          continue;
        }
        const adapter = await params.api.runtime.channel.outbound.loadAdapter("telegram");
        const send = adapter?.sendText;
        if (!send) {
          params.api.logger.warn(
            "device-pair: telegram outbound adapter unavailable for pairing notifications",
          );
          continue;
        }
        const observation = await subscriberStore.observe(entry.key);
        const subscriber = observation.value;
        if (!subscriber || !shouldNotifySubscriberForRequest(subscriber, request)) {
          continue;
        }
        try {
          await send({
            cfg: params.api.config,
            to: subscriber.to,
            text,
            ...(subscriber.accountId ? { accountId: subscriber.accountId } : {}),
            ...(subscriber.messageThreadId != null ? { threadId: subscriber.messageThreadId } : {}),
          });
        } catch (err) {
          params.api.logger.warn(
            `device-pair: failed to send pairing notification to ${subscriber.to}: ${formatErrorMessage(err)}`,
          );
          continue;
        }
        delivered = true;
        if (subscriber.mode === "once") {
          deliveredOneShots.add(entry.key);
          // A changed row belongs to its writer; never recapture it after delivery.
          await writeNotifyState(() =>
            subscriberStore.compareAndApply(entry.key, observation.comparison, {
              operation: "delete",
              action: "delete",
            }),
          );
        }
      }

      if (delivered) {
        await writeNotifyState(() =>
          seenRequestStore.register(
            notifyRequestStoreKey(request.requestId),
            { requestId: request.requestId, notifiedAtMs: now },
            { ttlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS },
          ),
        );
        notifiedRequestIds.add(request.requestId);
      }
    }
  }
}

type NotifyCommandContext = Pick<
  PluginCommandContext,
  "assertOwnerCurrent" | "channel" | "senderId" | "from" | "to" | "accountId" | "messageThreadId"
>;

export async function armPairNotifyOnce(params: {
  api: OpenClawPluginApi;
  ctx: NotifyCommandContext;
}): Promise<boolean> {
  if (params.ctx.channel !== "telegram") {
    return false;
  }
  const target = resolveNotifyTarget(params.ctx);
  if (!target) {
    return false;
  }

  await registerNotifySubscriber({
    api: params.api,
    target,
    mode: "once",
    refresh: true,
    assertCurrent: params.ctx.assertOwnerCurrent,
  });
  return true;
}

export async function handleNotifyCommand(params: {
  api: OpenClawPluginApi;
  ctx: NotifyCommandContext;
  action: string;
}): Promise<{ text: string }> {
  const assertOwnerCurrent = params.ctx.assertOwnerCurrent;
  if (params.ctx.channel !== "telegram") {
    return { text: "Pairing notifications are currently supported only on Telegram." };
  }

  const target = resolveNotifyTarget(params.ctx);
  if (!target) {
    return { text: "Could not resolve Telegram target for this chat." };
  }

  const subscriberStore = openNotifySubscriberStore(params.api);
  const targetStoreKey = notifySubscriberStoreKey(target);

  if (params.action === "on" || params.action === "enable") {
    await registerNotifySubscriber({
      api: params.api,
      target,
      mode: "persistent",
      refresh: false,
      assertCurrent: assertOwnerCurrent,
    });
    return {
      text:
        "✅ Pair request notifications enabled for this Telegram chat.\n" +
        "I will ping here when a new device pairing request arrives.",
    };
  }

  if (params.action === "off" || params.action === "disable") {
    await writeNotifyState(() =>
      subscriberStore.delete(targetStoreKey, { assertCurrent: assertOwnerCurrent }),
    );
    return { text: "✅ Pair request notifications disabled for this Telegram chat." };
  }

  if (params.action === "once" || params.action === "arm") {
    await armPairNotifyOnce({
      api: params.api,
      ctx: params.ctx,
    });
    return {
      text:
        "✅ One-shot pairing notification armed for this Telegram chat.\n" +
        "I will notify on the next new pairing request, then auto-disable.",
    };
  }

  if (params.action === "status" || params.action === "") {
    const [current, subscriberCount, pending] = await Promise.all([
      subscriberStore.lookup(targetStoreKey),
      subscriberStore.count
        ? subscriberStore.count()
        : subscriberStore.entries().then((entries) => entries.length),
      listDevicePairing(),
    ]);
    const enabled = Boolean(current);
    assertOwnerCurrent?.();
    const mode = current?.mode ?? "off";
    return {
      text: [
        `Pair request notifications: ${enabled ? "enabled" : "disabled"} for this chat.`,
        `Mode: ${mode}`,
        `Subscribers: ${subscriberCount}`,
        `Pending requests: ${pending.pending.length}`,
        "",
        "Use /pair notify on|off|once",
      ].join("\n"),
    };
  }

  return { text: "Usage: /pair notify on|off|once|status" };
}

export function startPairingNotifier(
  api: OpenClawPluginApi,
  scheduler: PluginServiceSchedulerV1,
): void {
  // Fence empty reads still in flight from an earlier service lifetime.
  notifyStateRevision++;
  // Keep the first scan off Gateway readiness; retirement joins delivery and its receipt.
  scheduler.schedule({
    id: "notifications",
    delayMs: NOTIFY_POLL_INTERVAL_MS,
    everyMs: NOTIFY_POLL_INTERVAL_MS,
    run: () =>
      notifyPendingPairingRequests({ api }).catch((err: unknown) => {
        api.logger.warn(`device-pair: notify poll failed: ${formatErrorMessage(err)}`);
      }),
  });
}
