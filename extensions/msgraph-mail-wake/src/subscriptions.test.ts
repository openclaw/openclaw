// Microsoft Graph Mail Wake tests cover subscription manager behavior.
import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import type { GraphWakeMailboxConfig } from "./config.js";
import { type GraphClient, GraphRequestError } from "./graph-client.js";
import {
  createGraphSubscriptionManager,
  type GraphWakeSubscriptionRecord,
  type GraphWakeSubscriptionStore,
} from "./subscriptions.js";

const NOTIFICATION_URL = "https://gateway.example.com/plugins/msgraph-mail-wake";

function createMemoryStore(): GraphWakeSubscriptionStore & {
  map: Map<string, GraphWakeSubscriptionRecord>;
} {
  const map = new Map<string, GraphWakeSubscriptionRecord>();
  return {
    map,
    register: (key, value) => void map.set(key, value),
    lookup: (key) => map.get(key),
    delete: (key) => map.delete(key),
    entries: () => [...map.entries()].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
}

function createMailbox(overrides?: Partial<GraphWakeMailboxConfig>): GraphWakeMailboxConfig {
  return {
    mailboxId: "main",
    user: "ops@example.com",
    changeType: "created",
    fetchMessage: true,
    wake: { sessionKey: "agent:main:main", deliveryMode: "none" },
    resource: "users/ops%40example.com/messages",
    ...overrides,
  };
}

let nextSubscriptionId = 0;

function createFakeClient() {
  nextSubscriptionId = 0;
  const calls: { op: string }[] = [];
  const client: GraphClient = {
    createSubscription: vi.fn(async ({ expirationDateTime }: { expirationDateTime: string }) => {
      calls.push({ op: "create" });
      nextSubscriptionId += 1;
      return { id: `sub-${String(nextSubscriptionId)}`, expirationDateTime };
    }),
    renewSubscription: vi.fn(
      async ({ expirationDateTime }: { subscriptionId: string; expirationDateTime: string }) => {
        calls.push({ op: "renew" });
        return { id: "renewed", expirationDateTime };
      },
    ),
    deleteSubscription: vi.fn(async () => {
      calls.push({ op: "delete" });
    }),
    // Orphan-reconciliation list; kept out of the `calls` op-sequence tracking
    // so existing create/renew/delete choreography assertions stay unchanged.
    listSubscriptions: vi.fn(async () => []),
    fetchMessage: vi.fn(async () => null),
  };
  return { client, calls };
}

function createManager(params: {
  client: GraphClient;
  store: GraphWakeSubscriptionStore;
  mailboxes?: GraphWakeMailboxConfig[];
  notificationUrl?: string;
  handleLifecycleEvents?: boolean;
  onResync?: (resyncParams: {
    record: GraphWakeSubscriptionRecord;
    reason: string;
  }) => Promise<boolean>;
  logger?: PluginLogger;
}) {
  return createGraphSubscriptionManager({
    client: params.client,
    store: params.store,
    mailboxes: params.mailboxes ?? [createMailbox()],
    notificationUrl: params.notificationUrl ?? NOTIFICATION_URL,
    subscription: {
      expirationMinutes: 10_000,
      renewEveryMinutes: 1440,
      handleLifecycleEvents: params.handleLifecycleEvents ?? true,
    },
    ...(params.onResync ? { onResync: params.onResync } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
  });
}

describe("createGraphSubscriptionManager", () => {
  it("creates and persists a subscription per configured mailbox on start", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store });

    await manager.start();
    await manager.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(client.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "users/ops%40example.com/messages",
        changeType: "created",
        notificationUrl: NOTIFICATION_URL,
        lifecycleNotificationUrl: NOTIFICATION_URL,
      }),
    );
    const stored = store.lookup("main");
    expect(stored?.subscriptionId).toBe("sub-1");
    expect(stored?.clientState).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.notificationUrl).toBe(NOTIFICATION_URL);
    expect(manager.lookup("sub-1")?.mailboxId).toBe("main");
  });

  it("deletes a newly created remote subscription when durable persistence fails", async () => {
    const { client, calls } = createFakeClient();
    const store: GraphWakeSubscriptionStore = {
      register: () => {
        throw new Error("sqlite unavailable");
      },
      lookup: () => undefined,
      delete: () => false,
      entries: () => [],
    };
    const manager = createManager({ client, store });

    await expect(manager.start()).rejects.toThrow("subscription startup incomplete");
    await manager.stop({ deleteRemote: false });

    expect(client.deleteSubscription).toHaveBeenCalledWith({ subscriptionId: "sub-1" });
    expect(calls.map((call) => call.op)).toEqual(["create", "delete"]);
    expect(manager.lookup("sub-1")).toBeUndefined();
  });

  it("renews an existing stored subscription on start instead of creating", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    await createManager({ client, store }).start();

    const second = createManager({ client, store });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(client.renewSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1" }),
    );
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
  });

  it("replaces the subscription when renewal reports it gone, with a resync wake", async () => {
    const { client } = createFakeClient();
    client.renewSubscription = vi.fn(async () => null);
    const store = createMemoryStore();
    await createManager({ client, store }).start();

    const onResync = vi.fn(async () => true);
    const second = createManager({ client, store, onResync });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(2);
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(store.lookup("main")?.subscriptionId).toBe("sub-2");
    expect(onResync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "subscription_missing_on_update" }),
    );
  });

  it("renews every configured mailbox in a renewNow pass", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store });
    await manager.start();

    await manager.renewNow();
    await manager.stop({ deleteRemote: false });

    expect(client.renewSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1" }),
    );
  });

  it("prunes subscriptions whose mailbox is no longer configured", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const first = createManager({ client, store });
    await first.start();
    await first.stop({ deleteRemote: false });

    const second = createManager({ client, store, mailboxes: [] });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(client.deleteSubscription).toHaveBeenCalledWith({ subscriptionId: "sub-1" });
    expect(store.lookup("main")).toBeUndefined();
  });

  it("replaces the subscription on subscriptionRemoved with a resync wake", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const onResync = vi.fn(async () => true);
    const manager = createManager({ client, store, onResync });
    await manager.start();

    const record = manager.lookup("sub-1");
    expect(record).toBeDefined();
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "subscriptionRemoved" });
    }
    await manager.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(2);
    // subscriptionRemoved means Graph has already removed the old remote
    // subscription; issuing DELETE would add no safety and can mask ordering.
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(store.lookup("main")?.subscriptionId).toBe("sub-2");
    expect(manager.lookup("sub-1")).toBeUndefined();
    expect(onResync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "subscription_removed" }),
    );
  });

  it("renews (reauthorizes) in place on reauthorizationRequired without replacing", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store });
    await manager.start();

    const record = manager.lookup("sub-1");
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "reauthorizationRequired" });
    }
    await manager.stop({ deleteRemote: false });

    expect(client.renewSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1" }),
    );
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
  });

  it("renews and schedules a resynchronization wake on missed notifications", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const onResync = vi.fn(async () => true);
    const manager = createManager({ client, store, onResync });
    await manager.start();

    const record = manager.lookup("sub-1");
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "missed" });
    }
    await manager.stop({ deleteRemote: false });

    expect(client.renewSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1" }),
    );
    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missed_notifications" }),
    );
  });

  it("surfaces renewal, recreation, and resync failures as retryable", async () => {
    const updateFixture = createFakeClient();
    const updateStore = createMemoryStore();
    const updateManager = createManager({ client: updateFixture.client, store: updateStore });
    await updateManager.start();
    updateFixture.client.renewSubscription = vi.fn(async () => {
      throw new Error("renew failed");
    });
    const updateRecord = updateManager.lookup("sub-1");
    expect(updateRecord).toBeDefined();
    if (updateRecord) {
      await expect(
        updateManager.handleLifecycleEvent({
          record: updateRecord,
          lifecycleEvent: "reauthorizationRequired",
        }),
      ).resolves.toEqual({
        ok: false,
        retryable: true,
        code: "subscription_update_failed",
      });
    }
    await updateManager.stop({ deleteRemote: false });

    const createFixture = createFakeClient();
    const createStore = createMemoryStore();
    const createManagerUnderTest = createManager({
      client: createFixture.client,
      store: createStore,
    });
    await createManagerUnderTest.start();
    createFixture.client.createSubscription = vi.fn(async () => {
      throw new Error("create failed");
    });
    const createRecord = createManagerUnderTest.lookup("sub-1");
    expect(createRecord).toBeDefined();
    if (createRecord) {
      await expect(
        createManagerUnderTest.handleLifecycleEvent({
          record: createRecord,
          lifecycleEvent: "subscriptionRemoved",
        }),
      ).resolves.toEqual({
        ok: false,
        retryable: true,
        code: "subscription_create_failed",
      });
    }
    await createManagerUnderTest.stop({ deleteRemote: false });

    const resyncFixture = createFakeClient();
    const resyncStore = createMemoryStore();
    const resyncManager = createManager({
      client: resyncFixture.client,
      store: resyncStore,
      onResync: vi.fn(async () => false),
    });
    await resyncManager.start();
    const resyncRecord = resyncManager.lookup("sub-1");
    expect(resyncRecord).toBeDefined();
    if (resyncRecord) {
      await expect(
        resyncManager.handleLifecycleEvent({ record: resyncRecord, lifecycleEvent: "missed" }),
      ).resolves.toEqual({ ok: false, retryable: true, code: "resync_wake_failed" });
    }
    await resyncManager.stop({ deleteRemote: false });
  });

  it("throttles resync wakes per mailbox", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const onResync = vi.fn(async () => true);
    const manager = createManager({ client, store, onResync });
    await manager.start();

    const record = manager.lookup("sub-1");
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "missed" });
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "missed" });
    }
    await manager.stop({ deleteRemote: false });

    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("ignores lifecycle events when handling is disabled", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store, handleLifecycleEvents: false });
    await manager.start();

    const record = manager.lookup("sub-1");
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "missed" });
    }
    await manager.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(client.renewSubscription).not.toHaveBeenCalled();
  });

  it("replaces the subscription when Graph-side config changes, with a resync wake", async () => {
    const { client, calls } = createFakeClient();
    const store = createMemoryStore();
    await createManager({ client, store }).start();

    const onResync = vi.fn(async () => true);
    const second = createManager({
      client,
      store,
      onResync,
      mailboxes: [
        createMailbox({
          folder: "inbox",
          resource: "users/ops%40example.com/mailFolders('inbox')/messages",
        }),
      ],
    });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(2);
    expect(client.deleteSubscription).toHaveBeenCalledWith({ subscriptionId: "sub-1" });
    expect(store.lookup("main")?.subscriptionId).toBe("sub-2");
    expect(onResync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "subscription_target_config_changed" }),
    );
    expect(calls.map((call) => call.op)).toEqual(["create", "create", "delete"]);
  });

  it("retires the old durable identity only after persisting an immutable replacement", async () => {
    const { client, calls } = createFakeClient();
    const store = createMemoryStore();
    const first = createManager({ client, store });
    await first.start();
    const oldRecord = store.lookup("main");
    expect(oldRecord).toBeDefined();
    await first.stop({ deleteRemote: false });

    let durableIdentityAtDelete: GraphWakeSubscriptionRecord | undefined;
    client.deleteSubscription = vi.fn(async ({ subscriptionId }) => {
      calls.push({ op: "delete" });
      expect(subscriptionId).toBe(oldRecord?.subscriptionId);
      durableIdentityAtDelete = store.lookup("main");
    });
    const second = createManager({
      client,
      store,
      mailboxes: [
        createMailbox({
          folder: "inbox",
          resource: "users/ops%40example.com/mailFolders('inbox')/messages",
        }),
      ],
      onResync: vi.fn(async () => true),
    });
    await second.start();
    await second.stop({ deleteRemote: false });

    const replacement = store.lookup("main");
    expect(durableIdentityAtDelete?.subscriptionId).toBe("sub-2");
    expect(durableIdentityAtDelete?.clientState).not.toBe(oldRecord?.clientState);
    expect(replacement?.subscriptionId).toBe("sub-2");
    expect(replacement?.clientState).toBe(durableIdentityAtDelete?.clientState);
    expect(store.entries()).toHaveLength(1);
    expect(second.lookup("sub-1")).toBeUndefined();
    expect(second.lookup("sub-2")?.clientState).toBe(replacement?.clientState);
    expect(calls.map((call) => call.op)).toEqual(["create", "create", "delete"]);
  });

  it("PATCHes a callback URL change without creating a duplicate subscription", async () => {
    const { client, calls } = createFakeClient();
    const store = createMemoryStore();
    const first = createManager({ client, store });
    await first.start();
    await first.stop({ deleteRemote: false });
    const createSubscription = vi.mocked(client.createSubscription);
    createSubscription.mockRejectedValueOnce(new Error("Graph duplicate subscription: 409"));

    const updatedUrl = "https://new-gateway.example.com/plugins/msgraph-mail-wake";
    const onResync = vi.fn(async () => true);
    const second = createManager({ client, store, notificationUrl: updatedUrl, onResync });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect(client.renewSubscription).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subscriptionId: "sub-1",
        notificationUrl: updatedUrl,
      }),
    );
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(calls.map((call) => call.op)).toEqual(["create", "renew"]);
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
    expect(store.lookup("main")?.notificationUrl).toBe(updatedUrl);
    expect(onResync).not.toHaveBeenCalled();
  });

  it("updates local-only config in place without Graph calls", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    await createManager({ client, store }).start();

    const second = createManager({
      client,
      store,
      mailboxes: [
        createMailbox({ wake: { sessionKey: "agent:main:reader", deliveryMode: "announce" } }),
      ],
    });
    await second.start();
    await second.stop({ deleteRemote: false });

    expect(client.createSubscription).toHaveBeenCalledTimes(1);
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(client.renewSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1" }),
    );
    expect(store.lookup("main")?.wake.sessionKey).toBe("agent:main:reader");
  });

  it("deletes remote subscriptions on stop only when asked", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store });
    await manager.start();

    await manager.stop({ deleteRemote: false });
    expect(client.deleteSubscription).not.toHaveBeenCalled();
    expect(store.lookup("main")).toBeDefined();

    await manager.stop({ deleteRemote: true });
    expect(client.deleteSubscription).toHaveBeenCalledWith({ subscriptionId: "sub-1" });
    expect(store.lookup("main")).toBeUndefined();
  });

  it("never logs raw subscription ids, users, or mailbox identifiers", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const manager = createManager({
      client,
      store,
      logger,
      mailboxes: [createMailbox({ mailboxId: "mbx-ops" })],
    });
    await manager.start();

    const record = manager.lookup("sub-1");
    if (record) {
      await manager.handleLifecycleEvent({ record, lifecycleEvent: "subscriptionRemoved" });
    }
    await manager.stop({ deleteRemote: true });

    const logged = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .flat()
      .join("\n");
    expect(logged).not.toContain("sub-1");
    expect(logged).not.toContain("ops@example.com");
    expect(logged).not.toContain("mbx-ops");
  });

  it("retries create once with a clamped expiration when the tenant reports a lower ceiling", async () => {
    const { client } = createFakeClient();
    const create = vi.mocked(client.createSubscription);
    // First create is rejected with the tenant's real ceiling; the retry
    // succeeds with a clamped expiration.
    create.mockRejectedValueOnce(
      new GraphRequestError({
        op: "create_subscription",
        status: 400,
        graphErrorCode: "ExtensionError",
        expirationMaxMinutes: 5_000,
      }),
    );
    const store = createMemoryStore();
    const manager = createManager({ client, store });

    await manager.start();
    await manager.stop({ deleteRemote: false });

    expect(create).toHaveBeenCalledTimes(2);
    // The retry expiration is clamped to (ceiling - 10) minutes from now.
    const retryArgs = create.mock.calls[1]?.[0] as { expirationDateTime: string };
    const retryMinutes = Math.round(
      (new Date(retryArgs.expirationDateTime).getTime() - Date.now()) / 60_000,
    );
    expect(retryMinutes).toBeGreaterThanOrEqual(4_985);
    expect(retryMinutes).toBeLessThanOrEqual(4_990);
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
  });

  it("retries create when the tenant ceiling equals the requested minutes (clock skew)", async () => {
    const { client } = createFakeClient();
    const create = vi.mocked(client.createSubscription);
    // Positive clock skew: Graph rejects a request at exactly the ceiling and
    // reports that same ceiling back (equal to requested). `<=` must still fire
    // the retry, or createForMailbox hard-fails on the exact ceiling value.
    create.mockRejectedValueOnce(
      new GraphRequestError({
        op: "create_subscription",
        status: 400,
        graphErrorCode: "ExtensionError",
        expirationMaxMinutes: 10_000,
      }),
    );
    const store = createMemoryStore();
    const manager = createManager({ client, store });

    await manager.start();
    await manager.stop({ deleteRemote: false });

    expect(create).toHaveBeenCalledTimes(2);
    // Retry expiration is clamped to (ceiling - 10) minutes from now ≈ 9990.
    const retryArgs = create.mock.calls[1]?.[0] as { expirationDateTime: string };
    const retryMinutes = Math.round(
      (new Date(retryArgs.expirationDateTime).getTime() - Date.now()) / 60_000,
    );
    expect(retryMinutes).toBeGreaterThanOrEqual(9_985);
    expect(retryMinutes).toBeLessThanOrEqual(9_990);
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
  });

  it("applies the learned ceiling to renew after a clamp, not just create", async () => {
    const { client } = createFakeClient();
    const create = vi.mocked(client.createSubscription);
    const renew = vi.mocked(client.renewSubscription);
    // First create is rejected with a low ceiling; the retry succeeds. A later
    // renew must reuse that learned ceiling, not the (too-high) configured value.
    create.mockRejectedValueOnce(
      new GraphRequestError({
        op: "create_subscription",
        status: 400,
        graphErrorCode: "ExtensionError",
        expirationMaxMinutes: 5_000,
      }),
    );
    const store = createMemoryStore();
    const manager = createManager({ client, store });

    await manager.start();
    // Force a renew of the persisted record and read the expiration it requests.
    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
    await manager.renewNow();
    await manager.stop({ deleteRemote: false });

    expect(renew).toHaveBeenCalledTimes(1);
    const renewArgs = renew.mock.calls[0]?.[0] as { expirationDateTime: string };
    const renewMinutes = Math.round(
      (new Date(renewArgs.expirationDateTime).getTime() - Date.now()) / 60_000,
    );
    // (ceiling 5000 - margin 10) ≈ 4990, NOT the configured 10000.
    expect(renewMinutes).toBeGreaterThanOrEqual(4_985);
    expect(renewMinutes).toBeLessThanOrEqual(4_990);
  });

  it("does not retry create when the failure carries no expiration ceiling", async () => {
    const { client } = createFakeClient();
    const create = vi.mocked(client.createSubscription);
    create.mockRejectedValue(
      new GraphRequestError({
        op: "create_subscription",
        status: 403,
        graphErrorCode: "Forbidden",
      }),
    );
    const store = createMemoryStore();
    const manager = createManager({ client, store });

    await expect(manager.start()).rejects.toThrow("subscription startup incomplete");
    await manager.stop({ deleteRemote: false });

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.lookup("main")).toBeUndefined();
  });

  it("deletes orphaned subscriptions that point at our URL but are untracked", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const listSubscriptions = vi.mocked(client.listSubscriptions);
    listSubscriptions.mockResolvedValue([
      // Ours + tracked (this is sub-1, created on start): must be kept.
      { id: "sub-1", notificationUrl: NOTIFICATION_URL },
      // Ours + untracked: an orphan from a prior double-create — delete it.
      { id: "orphan-1", notificationUrl: NOTIFICATION_URL },
      // Another app's subscription (different URL): must never be touched.
      { id: "other-app", notificationUrl: "https://other.example.com/hook" },
    ]);
    const manager = createManager({ client, store });

    await manager.start();
    await manager.stop({ deleteRemote: false });

    expect(client.deleteSubscription).toHaveBeenCalledTimes(1);
    expect(client.deleteSubscription).toHaveBeenCalledWith({ subscriptionId: "orphan-1" });
  });

  it("keeps startup healthy when orphan listing fails", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    vi.mocked(client.listSubscriptions).mockRejectedValue(new Error("list failed"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const manager = createManager({ client, store, logger });

    // A list failure must only warn — never throw or break startup.
    await expect(manager.start()).resolves.toBeUndefined();
    await manager.stop({ deleteRemote: false });

    expect(store.lookup("main")?.subscriptionId).toBe("sub-1");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("orphan_subscription_list_failed"),
    );
  });

  it("skips orphan reconciliation when no mailbox is configured", async () => {
    const { client } = createFakeClient();
    const store = createMemoryStore();
    const manager = createManager({ client, store, mailboxes: [] });

    await manager.start();
    await manager.stop({ deleteRemote: false });

    expect(client.listSubscriptions).not.toHaveBeenCalled();
  });
});
