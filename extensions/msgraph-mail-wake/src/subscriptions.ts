// Microsoft Graph subscription lifecycle manager for the mail-wake plugin.
// Owns create/update/delete of Graph change-notification subscriptions for the
// configured mailboxes, with provider identity persisted in OpenClaw plugin
// state and renewal timers owned by the current Gateway process.
//
// Lifecycle semantics:
//   reauthorizationRequired -> PATCH expiration in place
//   missed                  -> PATCH in place + mailbox resynchronization wake
//   subscriptionRemoved     -> create a replacement + resynchronization wake
//
// Graph PATCH supports expirationDateTime and notificationUrl. Resource and
// changeType are immutable; only their changes use replacement. Replacements
// are created and durably installed before the old subscription is retired, so
// creation/persistence failure leaves the old subscription active and a
// successful replacement has no subscription gap.
import { createHash, randomBytes } from "node:crypto";
import type { PluginLogger } from "../api.js";
import type { PluginStateSyncKeyedStore } from "../runtime-api.js";
import type { GraphWakeMailboxConfig } from "./config.js";
import { type GraphClient, GraphRequestError } from "./graph-client.js";
import type { GraphLifecycleEvent } from "./notifications.js";
import { describeErrorRedacted, redactHandle } from "./redact.js";

const RESYNC_MIN_INTERVAL_MS = 5 * 60_000;
/** Margin subtracted from a tenant-reported expiration ceiling on adaptive
 * retry, plus the floor we never clamp below. */
const ADAPTIVE_EXPIRATION_MARGIN_MINUTES = 10;
const ADAPTIVE_EXPIRATION_FLOOR_MINUTES = 60;

export type GraphWakeSubscriptionRecord = {
  mailboxId: string;
  user: string;
  folder?: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  fetchMessage: boolean;
  wake: GraphWakeMailboxConfig["wake"];
  subscriptionId: string;
  /** Shared secret echoed by Graph on every notification; never logged. */
  clientState: string;
  expirationDateTime: string;
};

export type GraphWakeSubscriptionStore = Pick<
  PluginStateSyncKeyedStore<GraphWakeSubscriptionRecord>,
  "register" | "lookup" | "delete" | "entries"
>;

export type GraphLifecycleHandlingResult =
  | {
      ok: true;
      action: "reauthorized" | "resynchronized" | "recreated" | "ignored" | "handling_disabled";
    }
  | {
      ok: false;
      retryable: true;
      code:
        | "lifecycle_busy"
        | "subscription_update_failed"
        | "subscription_create_failed"
        | "subscription_persist_failed"
        | "resync_wake_failed";
    };

export type GraphSubscriptionManager = {
  start: () => Promise<void>;
  lookup: (subscriptionId: string) => GraphWakeSubscriptionRecord | undefined;
  renewNow: () => Promise<void>;
  handleLifecycleEvent: (params: {
    record: GraphWakeSubscriptionRecord;
    lifecycleEvent: GraphLifecycleEvent;
  }) => Promise<GraphLifecycleHandlingResult>;
  stop: (params: { deleteRemote: boolean }) => Promise<void>;
};

type SubscriptionOperationResult =
  | { ok: true; record: GraphWakeSubscriptionRecord }
  | {
      ok: false;
      code:
        | "subscription_update_failed"
        | "subscription_create_failed"
        | "subscription_persist_failed"
        | "resync_wake_failed";
    };

class GraphSubscriptionStartError extends Error {
  override name = "GraphSubscriptionStartError";
}

export function buildGraphWakeClientState(mailboxId: string): string {
  return createHash("sha256")
    .update(`${mailboxId}|${randomBytes(24).toString("hex")}`)
    .digest("hex");
}

export function createGraphSubscriptionManager(params: {
  client: GraphClient;
  store: GraphWakeSubscriptionStore;
  mailboxes: GraphWakeMailboxConfig[];
  notificationUrl: string;
  subscription: {
    expirationMinutes: number;
    renewEveryMinutes: number;
    handleLifecycleEvents: boolean;
  };
  onResync?: (params: { record: GraphWakeSubscriptionRecord; reason: string }) => Promise<boolean>;
  logger?: PluginLogger;
  now?: () => Date;
}): GraphSubscriptionManager {
  const now = params.now ?? (() => new Date());
  const bySubscriptionId = new Map<string, GraphWakeSubscriptionRecord>();
  const inFlightMailboxes = new Set<string>();
  const lastResyncAtMs = new Map<string, number>();
  let renewInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // The effective expiration starts at the configured value but is lowered when
  // the adaptive retry learns a lower tenant ceiling, so BOTH create and renew
  // honor it and it is not re-learned on every start.
  let effectiveExpirationMinutes = params.subscription.expirationMinutes;

  /** Expiration ISO string `minutes` from now. */
  const expirationFromNow = (minutes: number): string =>
    new Date(now().getTime() + minutes * 60_000).toISOString();
  const nextExpiration = (): string => expirationFromNow(effectiveExpirationMinutes);

  const mailboxHandle = (mailboxId: string): string => redactHandle(mailboxId);

  const persist = (record: GraphWakeSubscriptionRecord): void => {
    params.store.register(record.mailboxId, record);
    bySubscriptionId.set(record.subscriptionId, record);
  };

  const forget = (record: GraphWakeSubscriptionRecord): void => {
    bySubscriptionId.delete(record.subscriptionId);
    params.store.delete(record.mailboxId);
  };

  const scheduleResync = async (
    record: GraphWakeSubscriptionRecord,
    reason: string,
  ): Promise<boolean> => {
    if (!params.onResync) {
      return true;
    }
    const last = lastResyncAtMs.get(record.mailboxId) ?? 0;
    if (now().getTime() - last < RESYNC_MIN_INTERVAL_MS) {
      return true;
    }
    try {
      const accepted = await params.onResync({ record, reason });
      if (!accepted) {
        params.logger?.warn?.(
          `[msgraph-mail-wake] resync_wake_rejected; mailbox="${mailboxHandle(record.mailboxId)}"`,
        );
        return false;
      }
      lastResyncAtMs.set(record.mailboxId, now().getTime());
      return true;
    } catch (err) {
      params.logger?.warn?.(
        `[msgraph-mail-wake] resync_wake_failed; mailbox="${mailboxHandle(record.mailboxId)}"; error=${describeErrorRedacted(err)}`,
      );
      return false;
    }
  };

  const buildRecord = (
    mailbox: GraphWakeMailboxConfig,
    subscription: { id: string; expirationDateTime?: string },
    clientState: string,
    expirationDateTime: string,
  ): GraphWakeSubscriptionRecord => ({
    mailboxId: mailbox.mailboxId,
    user: mailbox.user,
    ...(mailbox.folder ? { folder: mailbox.folder } : {}),
    resource: mailbox.resource,
    changeType: mailbox.changeType,
    notificationUrl: params.notificationUrl,
    fetchMessage: mailbox.fetchMessage,
    wake: mailbox.wake,
    subscriptionId: subscription.id,
    clientState,
    expirationDateTime: subscription.expirationDateTime ?? expirationDateTime,
  });

  const createForMailbox = async (
    mailbox: GraphWakeMailboxConfig,
  ): Promise<SubscriptionOperationResult> => {
    const clientState = buildGraphWakeClientState(mailbox.mailboxId);
    // Start from the effective ceiling so a ceiling learned by an earlier
    // create/recreate is not re-tried from the (too-high) configured value.
    let expirationMinutes = effectiveExpirationMinutes;
    let expirationDateTime = expirationFromNow(expirationMinutes);
    const create = (expiration: string): Promise<{ id: string; expirationDateTime?: string }> =>
      params.client.createSubscription({
        resource: mailbox.resource,
        changeType: mailbox.changeType,
        notificationUrl: params.notificationUrl,
        lifecycleNotificationUrl: params.notificationUrl,
        expirationDateTime: expiration,
        clientState,
      });
    let subscription: { id: string; expirationDateTime?: string };
    try {
      subscription = await create(expirationDateTime);
    } catch (err) {
      // Adaptive ceiling: if the tenant rejected our expiration and reported a
      // maximum at or below what we requested, retry ONCE clamped just below it
      // (floored) so any tenant's real ceiling is honored without a config
      // change. Equal-to-requested must also retry: positive clock skew makes
      // Graph reject a request at exactly the ceiling while reporting that same
      // ceiling back, so `<=` (not `<`) is required or that request hard-fails.
      if (
        err instanceof GraphRequestError &&
        err.expirationMaxMinutes !== undefined &&
        err.expirationMaxMinutes <= expirationMinutes
      ) {
        expirationMinutes = Math.max(
          err.expirationMaxMinutes - ADAPTIVE_EXPIRATION_MARGIN_MINUTES,
          ADAPTIVE_EXPIRATION_FLOOR_MINUTES,
        );
        // Persist the learned ceiling into manager state so subsequent renews
        // (and any recreate) also respect it, not just this one create.
        effectiveExpirationMinutes = expirationMinutes;
        expirationDateTime = expirationFromNow(expirationMinutes);
        params.logger?.info?.(
          `[msgraph-mail-wake] subscription_expiration_clamped; mailbox="${mailboxHandle(mailbox.mailboxId)}"; expiration_minutes=${String(expirationMinutes)}`,
        );
        try {
          subscription = await create(expirationDateTime);
        } catch (retryErr) {
          params.logger?.error?.(
            `[msgraph-mail-wake] subscription_create_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(retryErr)}`,
          );
          return { ok: false, code: "subscription_create_failed" };
        }
      } else {
        params.logger?.error?.(
          `[msgraph-mail-wake] subscription_create_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(err)}`,
        );
        return { ok: false, code: "subscription_create_failed" };
      }
    }

    const record = buildRecord(mailbox, subscription, clientState, expirationDateTime);
    try {
      persist(record);
    } catch (err) {
      params.logger?.error?.(
        `[msgraph-mail-wake] subscription_persist_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(err)}`,
      );
      // Never leave a remote subscription whose id/clientState was not stored:
      // after restart it could not be authenticated, renewed, or deleted.
      try {
        await params.client.deleteSubscription({ subscriptionId: subscription.id });
      } catch (cleanupErr) {
        params.logger?.warn?.(
          `[msgraph-mail-wake] untracked_subscription_cleanup_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(cleanupErr)}`,
        );
      }
      return { ok: false, code: "subscription_persist_failed" };
    }
    params.logger?.info?.(
      `[msgraph-mail-wake] subscription_active; subscription="${redactHandle(subscription.id)}"; mailbox="${mailboxHandle(mailbox.mailboxId)}"`,
    );
    return { ok: true, record };
  };

  /** Create/install the immutable replacement before retiring the old record. */
  const replaceImmutableSubscription = async (
    mailbox: GraphWakeMailboxConfig,
    previous: GraphWakeSubscriptionRecord,
    resyncReason: string,
  ): Promise<SubscriptionOperationResult> => {
    const created = await createForMailbox(mailbox);
    if (!created.ok) {
      return created;
    }
    bySubscriptionId.delete(previous.subscriptionId);
    try {
      await params.client.deleteSubscription({ subscriptionId: previous.subscriptionId });
    } catch (err) {
      // New subscription is already active. Keep it and let the old one expire;
      // retrying create would risk further overlap.
      params.logger?.warn?.(
        `[msgraph-mail-wake] superseded_subscription_delete_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(err)}`,
      );
    }
    const resynced = await scheduleResync(created.record, resyncReason);
    if (!resynced) {
      return { ok: false, code: "resync_wake_failed" };
    }
    return created;
  };

  /** The previous subscription is known absent (404/subscriptionRemoved). */
  const recreateMissingSubscription = async (
    mailbox: GraphWakeMailboxConfig,
  ): Promise<SubscriptionOperationResult> => await createForMailbox(mailbox);

  const applyLocalConfig = (
    record: GraphWakeSubscriptionRecord,
    mailbox: GraphWakeMailboxConfig,
    notificationUrl: string,
    expirationDateTime: string,
  ): GraphWakeSubscriptionRecord => {
    const updated: GraphWakeSubscriptionRecord = {
      ...record,
      user: mailbox.user,
      resource: mailbox.resource,
      changeType: mailbox.changeType,
      notificationUrl,
      fetchMessage: mailbox.fetchMessage,
      wake: mailbox.wake,
      expirationDateTime,
    };
    if (mailbox.folder) {
      updated.folder = mailbox.folder;
    } else {
      delete updated.folder;
    }
    return updated;
  };

  /** PATCH mutable fields in place; recreate only after a 404. */
  const updateExistingSubscription = async (
    mailbox: GraphWakeMailboxConfig,
    record: GraphWakeSubscriptionRecord,
  ): Promise<SubscriptionOperationResult> => {
    const expirationDateTime = nextExpiration();
    let renewed: { expirationDateTime?: string } | null;
    try {
      renewed = await params.client.renewSubscription({
        subscriptionId: record.subscriptionId,
        expirationDateTime,
        ...(record.notificationUrl !== params.notificationUrl
          ? { notificationUrl: params.notificationUrl }
          : {}),
      });
    } catch (err) {
      params.logger?.warn?.(
        `[msgraph-mail-wake] subscription_update_failed; mailbox="${mailboxHandle(mailbox.mailboxId)}"; error=${describeErrorRedacted(err)}`,
      );
      return { ok: false, code: "subscription_update_failed" };
    }
    if (!renewed) {
      params.logger?.warn?.(
        `[msgraph-mail-wake] subscription_missing_on_update; mailbox="${mailboxHandle(mailbox.mailboxId)}"`,
      );
      const recreated = await recreateMissingSubscription(mailbox);
      if (!recreated.ok) {
        return recreated;
      }
      const resynced = await scheduleResync(recreated.record, "subscription_missing_on_update");
      if (!resynced) {
        // Keep the old in-memory alias so a redelivered lifecycle event can
        // retry the resync against the new persisted subscription.
        return { ok: false, code: "resync_wake_failed" };
      }
      bySubscriptionId.delete(record.subscriptionId);
      return recreated;
    }
    const updated = applyLocalConfig(
      record,
      mailbox,
      params.notificationUrl,
      renewed.expirationDateTime ?? expirationDateTime,
    );
    persist(updated);
    return { ok: true, record: updated };
  };

  const reconcileMailbox = async (
    mailbox: GraphWakeMailboxConfig,
  ): Promise<SubscriptionOperationResult> => {
    const stored = params.store.lookup(mailbox.mailboxId);
    if (!stored) {
      return await createForMailbox(mailbox);
    }
    // Graph rejects a second subscription with the same resource + changeType.
    // Enter create-before-delete only when that immutable identity differs;
    // callback changes use the supported PATCH path below.
    const immutableReplacementRequired =
      stored.resource !== mailbox.resource || stored.changeType !== mailbox.changeType;
    if (immutableReplacementRequired) {
      params.logger?.info?.(
        `[msgraph-mail-wake] subscription_target_config_changed; mailbox="${mailboxHandle(mailbox.mailboxId)}"`,
      );
      return await replaceImmutableSubscription(
        mailbox,
        stored,
        "subscription_target_config_changed",
      );
    }
    return await updateExistingSubscription(mailbox, stored);
  };

  const withMailboxLock = async <T>(
    mailboxId: string,
    run: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> => {
    if (stopped || inFlightMailboxes.has(mailboxId)) {
      return { acquired: false };
    }
    inFlightMailboxes.add(mailboxId);
    try {
      return { acquired: true, value: await run() };
    } finally {
      inFlightMailboxes.delete(mailboxId);
    }
  };

  const renewAll = async (): Promise<boolean> => {
    let ok = true;
    for (const mailbox of params.mailboxes) {
      const locked = await withMailboxLock(mailbox.mailboxId, async () => {
        const record = params.store.lookup(mailbox.mailboxId);
        return record
          ? await updateExistingSubscription(mailbox, record)
          : await createForMailbox(mailbox);
      });
      if (!locked.acquired || !locked.value.ok) {
        ok = false;
      }
    }
    return ok;
  };

  return {
    start: async () => {
      stopped = false;
      bySubscriptionId.clear();
      for (const entry of params.store.entries()) {
        bySubscriptionId.set(entry.value.subscriptionId, entry.value);
      }

      const configuredIds = new Set(params.mailboxes.map((mailbox) => mailbox.mailboxId));
      for (const entry of params.store.entries()) {
        if (configuredIds.has(entry.value.mailboxId)) {
          continue;
        }
        try {
          await params.client.deleteSubscription({ subscriptionId: entry.value.subscriptionId });
        } catch (err) {
          params.logger?.warn?.(
            `[msgraph-mail-wake] stale_subscription_delete_failed; mailbox="${mailboxHandle(entry.value.mailboxId)}"; error=${describeErrorRedacted(err)}`,
          );
        }
        forget(entry.value);
      }

      let startOk = true;
      for (const mailbox of params.mailboxes) {
        const locked = await withMailboxLock(mailbox.mailboxId, () => reconcileMailbox(mailbox));
        if (!locked.acquired || !locked.value.ok) {
          startOk = false;
        }
      }

      // Self-heal orphans: a prior double-create (or a crash between create and
      // persist) can leave Graph subscriptions pointing at OUR notificationUrl
      // that we no longer track. Delete only those — never another app's subs
      // (different notificationUrl) and never one we now track. Best-effort:
      // any list/delete failure must warn, never break startup. Guarded to run
      // only when at least one mailbox is configured.
      if (params.mailboxes.length > 0) {
        try {
          const remoteSubscriptions = await params.client.listSubscriptions();
          for (const remote of remoteSubscriptions) {
            if (remote.notificationUrl !== params.notificationUrl) {
              continue;
            }
            if (bySubscriptionId.has(remote.id)) {
              continue;
            }
            try {
              await params.client.deleteSubscription({ subscriptionId: remote.id });
              params.logger?.info?.(
                `[msgraph-mail-wake] orphan_subscription_deleted; subscription="${redactHandle(remote.id)}"`,
              );
            } catch (err) {
              params.logger?.warn?.(
                `[msgraph-mail-wake] orphan_subscription_delete_failed; subscription="${redactHandle(remote.id)}"; error=${describeErrorRedacted(err)}`,
              );
            }
          }
        } catch (err) {
          params.logger?.warn?.(
            `[msgraph-mail-wake] orphan_subscription_list_failed; error=${describeErrorRedacted(err)}`,
          );
        }
      }

      const renewMs = params.subscription.renewEveryMinutes * 60_000;
      renewInterval = setInterval(() => {
        if (!stopped) {
          void renewAll();
        }
      }, renewMs);
      params.logger?.info?.(
        `[msgraph-mail-wake] subscription_manager_started; renew_minutes=${params.subscription.renewEveryMinutes}`,
      );
      if (!startOk) {
        throw new GraphSubscriptionStartError("subscription startup incomplete");
      }
    },

    lookup: (subscriptionId) => bySubscriptionId.get(subscriptionId),

    renewNow: async () => {
      await renewAll();
    },

    handleLifecycleEvent: async ({ record, lifecycleEvent }) => {
      const mailbox = params.mailboxes.find(
        (candidate) => candidate.mailboxId === record.mailboxId,
      );
      if (!mailbox) {
        return { ok: true, action: "ignored" };
      }
      if (!params.subscription.handleLifecycleEvents) {
        return { ok: true, action: "handling_disabled" };
      }
      const locked = await withMailboxLock(record.mailboxId, async () => {
        const current = params.store.lookup(record.mailboxId) ?? record;
        const staleEvent = current.subscriptionId !== record.subscriptionId;
        if (staleEvent) {
          // A previous attempt already installed the replacement but may have
          // failed to schedule the resync wake. Retry only the missing action;
          // never create another overlapping subscription.
          if (lifecycleEvent === "missed" || lifecycleEvent === "subscriptionRemoved") {
            const reason =
              lifecycleEvent === "missed" ? "missed_notifications" : "subscription_removed";
            const resynced = await scheduleResync(current, reason);
            if (!resynced) {
              return {
                ok: false,
                retryable: true,
                code: "resync_wake_failed",
              } as const;
            }
            bySubscriptionId.delete(record.subscriptionId);
            return {
              ok: true,
              action: lifecycleEvent === "missed" ? "resynchronized" : "recreated",
            } as const;
          }
          bySubscriptionId.delete(record.subscriptionId);
          return { ok: true, action: "reauthorized" } as const;
        }

        switch (lifecycleEvent) {
          case "reauthorizationRequired": {
            const updated = await updateExistingSubscription(mailbox, current);
            return updated.ok
              ? ({ ok: true, action: "reauthorized" } as const)
              : ({ ok: false, retryable: true, code: updated.code } as const);
          }
          case "missed": {
            const updated = await updateExistingSubscription(mailbox, current);
            if (!updated.ok) {
              return { ok: false, retryable: true, code: updated.code } as const;
            }
            const resynced = await scheduleResync(updated.record, "missed_notifications");
            return resynced
              ? ({ ok: true, action: "resynchronized" } as const)
              : ({
                  ok: false,
                  retryable: true,
                  code: "resync_wake_failed",
                } as const);
          }
          case "subscriptionRemoved": {
            const recreated = await recreateMissingSubscription(mailbox);
            if (!recreated.ok) {
              return { ok: false, retryable: true, code: recreated.code } as const;
            }
            const resynced = await scheduleResync(recreated.record, "subscription_removed");
            if (!resynced) {
              return {
                ok: false,
                retryable: true,
                code: "resync_wake_failed",
              } as const;
            }
            bySubscriptionId.delete(current.subscriptionId);
            return { ok: true, action: "recreated" } as const;
          }
        }
        lifecycleEvent satisfies never;
        throw new Error("unreachable Graph lifecycle event");
      });
      return locked.acquired
        ? locked.value
        : { ok: false, retryable: true, code: "lifecycle_busy" };
    },

    stop: async ({ deleteRemote }) => {
      stopped = true;
      if (renewInterval) {
        clearInterval(renewInterval);
        renewInterval = null;
      }
      if (!deleteRemote) {
        return;
      }
      for (const entry of params.store.entries()) {
        try {
          await params.client.deleteSubscription({ subscriptionId: entry.value.subscriptionId });
        } catch (err) {
          params.logger?.warn?.(
            `[msgraph-mail-wake] subscription_delete_failed; mailbox="${mailboxHandle(entry.value.mailboxId)}"; error=${describeErrorRedacted(err)}`,
          );
        }
        forget(entry.value);
      }
    },
  };
}
