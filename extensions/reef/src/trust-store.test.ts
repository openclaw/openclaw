import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateOperation,
  PluginStateOperationDefinitions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { reefPeerIdentity } from "./friend-types.js";
import { createRuntime } from "./state.test-support.js";
import {
  REEF_DELIVERY_STORE_OPTIONS,
  REEF_TRUST_STORE_OPTIONS,
  type ReefOutboundDeliveryBinding,
} from "./trust-store-format.js";
import {
  isReefPairingApprovalToken,
  openReefTrustStore,
  resolveReefTrustStoreKey,
} from "./trust-store.js";
import type { RelayFriend } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests({ closeDatabase: false });
    cleanup();
  }),
);
const stateDir = tempDirs.make("reef-trust-");
const noticeState = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
const overdueMs = 600_000;
const id = "01JZ0000000000000000000120";
const peerKey = () => resolveReefTrustStoreKey(config(), "clawd");
type TrustStore = ReturnType<typeof openReefTrustStore>;
let nextOperationWrite: (() => Promise<void> | void) | undefined;
let nextOperationRead: (() => void) | undefined;
let workerCommands: string[] = [];

function config(handle = "molty", relayUrl = "https://reefwire.ai") {
  return ReefChannelConfigSchema.parse({ handle, relayUrl });
}

function newStore(handle = "molty", relayUrl = "https://reefwire.ai", authority?: () => void) {
  return openReefTrustStore(runtime(), config(handle, relayUrl), authority);
}

function revocableAuthority() {
  let current = true;
  const revoked = new Error("trust authority revoked");
  return {
    revoked,
    setCurrent: (value: boolean) => {
      current = value;
    },
    assertCurrent: () => {
      if (!current) {
        throw revoked;
      }
    },
  };
}

function runtime() {
  const mockRuntime = createRuntime(stateDir);
  const open = mockRuntime.state.openKeyedStoreV2;
  mockRuntime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) => {
    const store = open<T>(options);
    const createOperation = store.createOperation;
    if (!createOperation) {
      throw new Error("Expected worker operation capability");
    }
    store.createOperation = <Operations extends PluginStateOperationDefinitions>(
      ...args: Parameters<typeof createOperation<Operations>>
    ): PluginStateOperation<Operations> => {
      const operation = createOperation<Operations>(...args);
      return {
        async execute(command, executionOptions) {
          const writes = executionOptions.writeStores.length > 0;
          if (writes) {
            const work = nextOperationWrite;
            nextOperationWrite = undefined;
            await work?.();
          }
          workerCommands.push(command.type);
          const receipt = await operation.execute(command, executionOptions);
          if (!writes) {
            const work = nextOperationRead;
            nextOperationRead = undefined;
            work?.();
          }
          return receipt;
        },
      };
    };
    return store;
  };
  return mockRuntime;
}

async function seedDelivery(
  store: TrustStore,
  peer: string,
  deliveryId: string,
  binding: ReefOutboundDeliveryBinding & { resendDisabled?: true },
) {
  await store.operationState.deliveries.register(
    `${store.operationState.identityScope}:${peer}:${deliveryId}`,
    { ...binding, sentAt: Date.now() },
  );
}

async function readDelivery(store: TrustStore, deliveryId = id) {
  return (await store.readOutboundDelivery("clawd", deliveryId))!;
}

async function rejectDelivery(store: TrustStore, peer: string, deliveryId: string) {
  const settlement = await store.readOutboundDelivery(peer, deliveryId);
  if (!settlement) {
    throw new Error(`Missing delivery ${deliveryId}`);
  }
  return settlement.reject("guard_deny");
}

async function trustedStore() {
  const store = newStore();
  const trustedPeer = peerTrust();
  const recipient = reefPeerIdentity(trustedPeer);
  await store.set("clawd", trustedPeer);
  return { store, trustedPeer, recipient };
}

async function deliveryFixture(
  deliveryId = id,
  options: Partial<ReefOutboundDeliveryBinding> & { resendDisabled?: true } = {},
) {
  const fixture = await trustedStore();
  const binding = { bodyHash: "a".repeat(64), recipient: fixture.recipient, ...options };
  await seedDelivery(fixture.store, "clawd", deliveryId, binding);
  return { ...fixture, binding };
}

function peerTrust() {
  const identity = generateIdentity();
  return {
    autonomy: "bounded" as const,
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 1,
    safetyNumberChanged: false,
    approvedAt: 1_752_537_600_000,
  };
}

function relayFriend(peer = "clawd", keyEpoch = 1): RelayFriend {
  const identity = generateIdentity();
  return {
    peer,
    status: "active",
    initiated_by: "molty",
    vouching_mutual: null,
    ed25519_pub: identity.signing.publicKey,
    x25519_pub: identity.encryption.publicKey,
    key_epoch: keyEpoch,
  };
}

beforeEach(async () => {
  resetPluginStateStoreForTests({ closeDatabase: false });
  // Clear rows and invalidate receipts while retaining the suite's database worker.
  const state = createRuntime(stateDir).state;
  for (const options of [REEF_TRUST_STORE_OPTIONS, REEF_DELIVERY_STORE_OPTIONS]) {
    await state.openKeyedStoreV2(options).clear();
  }
  workerCommands = [];
});

afterEach(() => {
  nextOperationWrite = undefined;
  nextOperationRead = undefined;
  vi.restoreAllMocks();
});

it("renews a rejection reservation while preserving duplicate receipt expiry", async () => {
  const { store } = await deliveryFixture();
  await rejectDelivery(store, "clawd", id);
  const { recovery } = await readDelivery(store);
  await recovery.reserve(noticeState);

  const raw = runtime().state.openSyncKeyedStore(REEF_DELIVERY_STORE_OPTIONS);
  const duplicate = await readDelivery(store);
  const saved = raw.entries()[0]!;
  raw.register(saved.key, saved.value, { ttlMs: 12 * 60 * 60 * 1_000 });
  const shortened = raw.entries()[0]!;
  expect(shortened.expiresAt).toBeGreaterThan(Date.now());

  expect(await duplicate.reject("guard_deny")).toMatchObject({ category: "guard_deny" });
  expect(raw.entries()[0]?.expiresAt).toBe(shortened.expiresAt);

  expect(await recovery.reserve({ lastRejectionAt: 20_000 })).toEqual({
    kind: "existing",
    state: noticeState,
  });
  const renewed = raw.entries()[0]!;
  expect(renewed.value).toEqual(shortened.value);
  const dayMs = 24 * 60 * 60 * 1_000;
  expect(renewed.expiresAt).toBeGreaterThan(shortened.expiresAt! + 60 * dayMs);
  expect(renewed.expiresAt).toBeLessThan(shortened.expiresAt! + 61 * dayMs);
});

it("isolates trust by relay identity instead of machine-specific key paths", async () => {
  const molty = newStore();
  await molty.set("clawd", peerTrust());

  expect(await newStore().get("clawd")).toBeDefined();
  expect(await newStore("other").get("clawd")).toBeUndefined();
  expect(await newStore("molty", "https://relay.example").get("clawd")).toBeUndefined();
});

it("persists and consumes concurrent outbound request intents separately from active trust", async () => {
  const store = newStore();

  const first = await store.beginRequest("clawd", 123);
  const second = await store.beginRequest("clawd", 456);
  expect(first.requestId).not.toBe(second.requestId);
  expect(await newStore().hasOutboundRequest("clawd")).toBe(true);
  expect(await store.get("clawd")).toBeUndefined();
  expect(await store.removeOutboundRequest("clawd", first.requestId)).toBe(true);
  expect([await first.status(), await second.status()]).toEqual(["superseded", "current"]);
  expect(await store.removeOutboundRequest("clawd", second.requestId)).toBe(true);
  expect(await store.hasOutboundRequest("clawd")).toBe(false);
  await expect(second.status()).rejects.toThrow("already consumed");
  const closed = await store.beginRequest("clawd");
  closed.close();
  await expect(closed.remove()).rejects.toThrow("already consumed");
  expect(await store.hasOutboundRequest("clawd")).toBe(true);
});

it.each(["bodyHash", "textHash", "recipient"] as const)(
  "refuses to consume a delivery whose %s changed after reading",
  async (field) => {
    const { store } = await deliveryFixture(id, { textHash: "b".repeat(64) });
    const settlement = await readDelivery(store);
    const raw = runtime().state.openSyncKeyedStore(REEF_DELIVERY_STORE_OPTIONS);
    const changed = {
      ...settlement.delivery,
      [field]: field === "recipient" ? reefPeerIdentity(peerTrust()) : "c".repeat(64),
    };
    raw.register(`${peerKey()}:${id}`, changed);

    expect(await settlement.consume()).toBe("unavailable");
    const reopened = await readDelivery(store);
    expect(reopened.delivery).toEqual(changed);
    expect(await reopened.consume()).toBe("consumed");
    expect(await store.readOutboundDelivery("clawd", id)).toBeUndefined();
  },
);

it("revokes captured peer authority on sanctioned writes without another worker request", async () => {
  const { store } = await trustedStore();
  const observed = (await store.observePeer("clawd"))!;
  workerCommands = [];
  observed.assertCurrent();
  expect(workerCommands).toHaveLength(0);

  runtime().state.openSyncKeyedStore(REEF_TRUST_STORE_OPTIONS).register(peerKey(), { revision: 2 });
  expect(() => observed.assertCurrent()).toThrow();
  expect(workerCommands).toHaveLength(0);
  expect(await store.get("clawd")).toBeUndefined();
});

it("preserves a rejection written after the accepted receipt read", async () => {
  const { store } = await deliveryFixture();
  const accepted = await readDelivery(store);
  const raw = runtime().state.openSyncKeyedStore(REEF_DELIVERY_STORE_OPTIONS);
  raw.register(`${peerKey()}:${id}`, {
    ...accepted.delivery,
    rejection: { category: "guard_deny" },
  });

  expect(await accepted.consume()).toBe("rejected");
  const current = await store.readOutboundDelivery("clawd", id);
  expect(current?.delivery.rejection).toEqual({ category: "guard_deny" });
});

it.each(["snapshot", "list", "delivery"] as const)(
  "rejects a borrowed %s result after channel closure",
  async (read) => {
    const authority = revocableAuthority();
    const store = newStore("molty", undefined, authority.assertCurrent);
    if (read === "delivery") {
      await store.set("clawd", peerTrust());
    }
    nextOperationRead = () => authority.setCurrent(false);
    const result =
      read === "delivery"
        ? store.readOutboundDelivery("clawd", id)
        : read === "list"
          ? store.list()
          : store.snapshot("clawd");
    await expect(result).rejects.toBe(authority.revoked);
  },
);

it("refuses an unaccepted removal and consumes accepted cleanup once", async () => {
  const { store: persisted } = await trustedStore();
  const before = await persisted.snapshot("clawd");
  const { revoked, assertCurrent, setCurrent } = revocableAuthority();
  const store = newStore("molty", undefined, assertCurrent);
  await expect(
    store.beginRemoval("clawd", () => {
      throw revoked;
    }),
  ).rejects.toBe(revoked);
  setCurrent(false);
  await expect(store.beginRemoval("clawd")).rejects.toBe(revoked);
  expect(await persisted.snapshot("clawd")).toEqual(before);

  setCurrent(true);
  const settle = await store.beginRemoval("clawd");
  setCurrent(false);
  (await persisted.beginRequest("clawd")).close();
  await settle();
  expect(await persisted.hasOutboundRequest("clawd")).toBe(false);
  (await persisted.beginRequest("clawd")).close();
  await expect(settle()).rejects.toThrow("already consumed");
  expect(await persisted.hasOutboundRequest("clawd")).toBe(true);
});

it("keeps rejection notices durable until the sender agent consumes them", async () => {
  const textHash = "c".repeat(64);
  const { store, recipient } = await deliveryFixture(id, { textHash });

  expect(await rejectDelivery(store, "clawd", id)).toMatchObject({ category: "guard_deny" });

  const reopened = newStore();
  const expected = { id, peer: "clawd", recipient, textHash, category: "guard_deny" };
  expect(await reopened.pendingOutboundRejections()).toMatchObject([expected]);
  expect(await (await readDelivery(reopened)).consume()).toBe("rejected");
  const { recovery } = await readDelivery(reopened);
  workerCommands = [];
  expect(await recovery.reserve(noticeState)).toEqual({ kind: "reserved" });
  expect(workerCommands).toHaveLength(1);
  recovery.assertCurrent();
  expect(workerCommands).toHaveLength(1);
  expect(await reopened.pendingOutboundRejections()).toMatchObject([
    { ...expected, reservedNotice: noticeState },
  ]);
  workerCommands = [];
  expect(await recovery.complete(noticeState)).toBe(true);
  expect(workerCommands).toHaveLength(1);
  expect(await reopened.pendingOutboundRejections()).toMatchObject([]);
  expect(await reopened.readOutboundDelivery("clawd", id)).toBeUndefined();
  expect(await reopened.rejectionNoticeState("clawd")).toEqual(noticeState);
  expect(await recovery.complete(noticeState)).toBe(true);
});

it("marks imported delivery rejections stop-only in the atomic receipt update", async () => {
  const { store, recipient } = await deliveryFixture(id, { resendDisabled: true });

  expect(await rejectDelivery(store, "clawd", id)).toMatchObject({ category: "guard_deny" });
  expect(await store.pendingOutboundRejections()).toMatchObject([
    {
      id,
      peer: "clawd",
      recipient,
      category: "guard_deny",
      reservedNotice: { lastRejectionAt: expect.any(Number) },
    },
  ]);
});

it("rejects recovery if peer keys change before rejection reservation", async () => {
  const { store } = await deliveryFixture();
  await rejectDelivery(store, "clawd", id);

  const selected = (await store.pendingOutboundRejections())[0]!;
  const previous = await store.snapshot("clawd");
  const writer = runtime().state.openSyncKeyedStore(REEF_TRUST_STORE_OPTIONS);
  nextOperationWrite = () =>
    writer.register(peerKey(), {
      ...previous,
      revision: previous.revision + 1,
      trust: peerTrust(),
    });
  await expect(selected.recovery.reserve({ lastRejectionAt: 10_000 })).rejects.toThrow(
    "changed keys before rejection recovery",
  );
  expect(await store.pendingOutboundRejections()).toMatchObject([]);
  expect((await readDelivery(store))?.delivery.rejection?.notice).toBeUndefined();
});

it.each(["overdue", "rejections"] as const)(
  "observes new deliveries and sanctioned sibling writes between %s scans",
  async (kind) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { store, trustedPeer: trust, recipient } = await trustedStore();
    const binding = { bodyHash: "a".repeat(64), recipient };
    const scan = async () =>
      kind === "overdue"
        ? await store.overdueOutboundDeliveries(600_000, Date.now() + 601_000)
        : await store.pendingOutboundRejections();
    expect(await scan()).toEqual([]);
    await store.set("other", trust);
    await store.set("stranger", trust);
    const peers = ["clawd", "clawd", "other", "stranger", "clawd", "other", "stranger"];
    const ids = peers.map((_, index) => String(index + 1).padStart(26, "0"));
    for (const [index, peer] of peers.entries()) {
      clock.mockReturnValue(now + index);
      const deliveryId = ids[index]!;
      await seedDelivery(store, peer, deliveryId, binding);
      if (kind === "rejections") {
        await rejectDelivery(store, peer, deliveryId);
      }
    }
    await store.remove("stranger");
    expect((await scan()).map((entry) => entry.id)).toEqual(
      ids.filter((_, i) => i !== 3 && i !== 6),
    );
    const writer = runtime().state.openSyncKeyedStore(REEF_TRUST_STORE_OPTIONS);
    writer.register(peerKey(), { revision: 2 });
    expect((await scan()).map((entry) => entry.id)).toEqual([ids[2], ids[5]]);
    writer.register(resolveReefTrustStoreKey(config(), "stranger"), { revision: 1, trust });
    expect((await scan()).map((entry) => entry.id)).toEqual([ids[2], ids[3], ids[5], ids[6]]);
    writer.register(resolveReefTrustStoreKey(config(), "other"), {
      revision: 2,
      trust: { ...trust, safetyNumberChanged: true },
    });
    expect((await scan()).map((entry) => entry.id)).toEqual([ids[3], ids[6]]);
  },
);

it("preserves concurrent completion, peer updates and restart-stable notice cooldowns", async () => {
  const latestId = "01JZ0000000000000000000122";
  const { store, recipient } = await deliveryFixture(latestId);
  await rejectDelivery(store, "clawd", latestId);
  const { recovery: latestRecovery } = await readDelivery(store, latestId);
  await latestRecovery.reserve(noticeState);
  const reopened = newStore();

  const olderId = "01JZ0000000000000000000123";
  const olderBinding = { bodyHash: "b".repeat(64), recipient };
  await seedDelivery(reopened, "clawd", olderId, olderBinding);
  await rejectDelivery(reopened, "clawd", olderId);
  const olderState = { lastRejectionAt: 9_000, lastResendAt: 9_100 };
  const { recovery: olderRecovery } = await readDelivery(reopened, olderId);
  await olderRecovery.reserve(olderState);
  nextOperationWrite = async () => {
    await latestRecovery.complete(noticeState);
    await store.setAutonomy("clawd", "extended");
  };
  expect(await olderRecovery.complete(olderState)).toBe(true);
  expect(await reopened.get("clawd")).toMatchObject({ autonomy: "extended" });
  expect(await reopened.readOutboundDelivery("clawd", latestId)).toBeUndefined();
  expect(await reopened.readOutboundDelivery("clawd", olderId)).toBeUndefined();
  expect(await reopened.rejectionNoticeState("clawd")).toEqual(noticeState);
});

it("rejects autonomy updates for untrusted or invalid peers", async () => {
  const store = newStore();

  await expect(store.setAutonomy("clawd", "notify-only")).rejects.toThrow("not locally trusted");
  await expect(store.get("not a handle")).rejects.toThrow("Invalid Reef peer handle");
});

it.each([
  ["channel", "autonomy"],
  ["owner", "autonomy"],
  ["channel", "removal"],
  ["owner", "removal"],
  ["channel", "request"],
  ["owner", "request"],
] as const)(
  "rejects %s-authorized %s after revocation during worker preparation",
  async (authority, action) => {
    const { revoked, assertCurrent, setCurrent } = revocableAuthority();
    const owner = authority === "owner" ? assertCurrent : undefined;
    const store = newStore("molty", undefined, authority === "channel" ? assertCurrent : undefined);
    await store.set("clawd", peerTrust());
    nextOperationWrite = () => setCurrent(false);

    await expect(
      action === "autonomy"
        ? store.setAutonomy("clawd", "extended", owner)
        : action === "removal"
          ? store.beginRemoval("clawd", owner)
          : store.beginRequest("clawd", 123, owner),
    ).rejects.toBe(revoked);
    expect(await newStore().get("clawd")).toMatchObject({ autonomy: "bounded" });
  },
);

it("updates autonomy atomically without overwriting concurrent safety state", async () => {
  const { store } = await trustedStore();
  const beforeSafetyChange = await store.snapshot("clawd");

  await store.setAutonomy("clawd", "extended");
  expect(await store.markSafetyNumberChanged("clawd", beforeSafetyChange.revision)).toBe(true);

  expect(await store.get("clawd")).toMatchObject({
    autonomy: "extended",
    safetyNumberChanged: true,
  });
});

it("preserves a concurrent autonomy update when repinning peer keys", async () => {
  const { store } = await trustedStore();
  const beforeRepin = await store.snapshot("clawd");
  const friend = relayFriend();

  await store.setAutonomy("clawd", "notify-only");
  expect(await store.commitPeerTrust(friend, { expectedRevision: beforeRepin.revision }, 123)).toBe(
    true,
  );

  expect(await store.get("clawd")).toMatchObject({
    autonomy: "notify-only",
    ed25519PublicKey: friend.ed25519_pub,
    approvedAt: 123,
  });
});

it("rejects a stale trust commit after local revocation", async () => {
  const store = newStore();
  const request = await store.beginRequest("clawd", 123);
  request.close();
  const beforeRemoval = await store.snapshot("clawd");

  workerCommands = [];
  await store.remove("clawd");
  expect(workerCommands).toHaveLength(1);

  workerCommands = [];
  expect(
    await store.commitPeerTrust(relayFriend(), {
      expectedRevision: beforeRemoval.revision,
      expectedOutboundRequestId: request.requestId,
    }),
  ).toBe(false);
  expect(workerCommands).toHaveLength(1);
  expect(await store.get("clawd")).toBeUndefined();
  expect(await store.hasOutboundRequest("clawd")).toBe(false);
});

it("binds pairing approvals to the relay identity and exact peer keys", async () => {
  const friend: RelayFriend = {
    ...relayFriend("clawd", 2),
    status: "pending",
    initiated_by: "clawd",
  };
  const molty = newStore();
  const token = molty.createPairingApproval(friend, (await molty.snapshot(friend.peer)).revision);

  expect(isReefPairingApprovalToken(token)).toBe(true);
  const approval = molty.parsePairingApproval(token);
  expect(approval).toEqual({ peer: "clawd", keyEpoch: 2, trustRevision: 0 });
  expect(await molty.matchesPairingApproval(token, friend)).toBe(true);
  expect(newStore("other").parsePairingApproval(token)).toBeUndefined();
  expect(
    await molty.matchesPairingApproval(token, { ...friend, ed25519_pub: "C".repeat(43) }),
  ).toBe(false);

  await molty.remove("clawd");
  expect(await molty.matchesPairingApproval(token, friend)).toBe(false);
});

it("reports an unacknowledged delivery overdue exactly once", async () => {
  const { store } = await deliveryFixture(id, { textHash: "b".repeat(64) });

  expect(await store.overdueOutboundDeliveries(overdueMs)).toEqual([]);
  const later = Date.now() + overdueMs + 1_000;
  expect(await store.overdueOutboundDeliveries(overdueMs, later)).toMatchObject([
    { peer: "clawd", id },
  ]);

  expect(await store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(true);
  expect(await store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(false);
  expect(await store.overdueOutboundDeliveries(overdueMs, later)).toEqual([]);
});

it("excludes rejected and unpinned deliveries from the overdue sweep", async () => {
  const rejectedId = "01JZ0000000000000000000141";
  const { store, trustedPeer, recipient } = await deliveryFixture(rejectedId);
  const later = Date.now() + overdueMs + 1_000;
  expect(await rejectDelivery(store, "clawd", rejectedId)).toMatchObject({
    category: "guard_deny",
  });

  const unpinnedId = "01JZ0000000000000000000142";
  await store.set("stranger", trustedPeer);
  await seedDelivery(store, "stranger", unpinnedId, { bodyHash: "d".repeat(64), recipient });
  await store.remove("stranger");

  expect(await store.overdueOutboundDeliveries(overdueMs, later)).toEqual([]);
  expect(await store.markOutboundDeliveryOverdueNotified("clawd", rejectedId)).toBe(false);
});
