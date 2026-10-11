import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateOperation,
  PluginStateOperationDefinitions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { reefPeerIdentity } from "./friend-types.js";
import {
  REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
  REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_TTL_MS,
  type ReefOutboundDeliveryBinding,
} from "./trust-store-format.js";
import {
  isReefPairingApprovalToken,
  openReefTrustStore,
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;
let nextOperationWrite: (() => Promise<void> | void) | undefined;
let nextOperationRead: (() => void) | undefined;
let workerCommands: string[] = [];

function config(handle = "molty", relayUrl = "https://reefwire.ai") {
  return ReefChannelConfigSchema.parse({ handle, relayUrl });
}

function runtime(host: "worker" | "legacy" = "worker") {
  const mockRuntime = createPluginRuntimeMock();
  mockRuntime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  mockRuntime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    if (host === "legacy") {
      const { createOperation: _createOperation, ...legacy } = store;
      return legacy;
    }
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

function beforeNextOperationWrite(work: () => Promise<void> | void) {
  nextOperationWrite = work;
}

function nativePeerWriter() {
  return runtime().state.openSyncKeyedStore({
    namespace: REEF_TRUST_STORE_NAMESPACE,
    maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

async function recordDelivery(
  store: ReturnType<typeof openReefTrustStore>,
  peer: string,
  id: string,
  binding: ReefOutboundDeliveryBinding,
  options: { resendDisabled?: true } = {},
) {
  const preparation = await store.prepareOutboundDelivery(peer, id);
  if (!preparation) {
    throw new Error(`Missing trusted peer ${peer}`);
  }
  await preparation.record(binding, options);
}

async function rejectDelivery(
  store: ReturnType<typeof openReefTrustStore>,
  peer: string,
  id: string,
  category = "guard_deny",
) {
  const settlement = await store.readOutboundDelivery(peer, id);
  if (!settlement) {
    throw new Error(`Missing delivery ${id}`);
  }
  return settlement.reject(category);
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

beforeEach(() => {
  resetPluginStateStoreForTests();
  workerCommands = [];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-trust-"));
});

afterEach(async () => {
  nextOperationWrite = undefined;
  nextOperationRead = undefined;
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("ReefTrustStore", () => {
  it("retains delivery bindings across envelope and receipt relay windows", () => {
    const opened: OpenAsyncKeyedStoreOptions[] = [];
    const mockRuntime = runtime();
    mockRuntime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
      opened.push(options);
      return createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    };

    openReefTrustStore(mockRuntime, config());

    expect(
      opened.find((options) => options.namespace === "outbound-deliveries")?.defaultTtlMs,
    ).toBe(61 * 24 * 60 * 60 * 1_000);
  });

  it.each(["worker", "legacy"] as const)(
    "renews a %s rejection reservation while preserving duplicate receipt expiry",
    async (host) => {
      const mockRuntime = runtime(host);
      const store = openReefTrustStore(mockRuntime, config());
      const trustedPeer = peerTrust();
      const recipient = reefPeerIdentity(trustedPeer);
      const id = "01JZ0000000000000000000128";
      const binding = { bodyHash: "a".repeat(64), recipient };
      const notice = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
      await store.set("clawd", trustedPeer);
      await recordDelivery(store, "clawd", id, binding);
      await rejectDelivery(store, "clawd", id);
      const recovery = (await store.readOutboundDelivery("clawd", id))!.recovery;
      await recovery.reserve(notice);

      const raw = mockRuntime.state.openSyncKeyedStore({
        namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
        maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
      });
      const duplicate = (await store.readOutboundDelivery("clawd", id))!;
      const saved = raw.entries()[0]!;
      raw.register(saved.key, saved.value, { ttlMs: 12 * 60 * 60 * 1_000 });
      const shortened = raw.entries()[0]!;
      expect(shortened.expiresAt).toBeGreaterThan(Date.now());

      expect(await duplicate.reject("guard_deny")).toMatchObject({ category: "guard_deny" });
      expect(raw.entries()[0]?.expiresAt).toBe(shortened.expiresAt);

      expect(
        await recovery.reserve({
          lastRejectionAt: 20_000,
        }),
      ).toEqual({ kind: "existing", state: notice });
      const renewed = raw.entries()[0]!;
      expect(renewed.value).toEqual(shortened.value);
      const dayMs = 24 * 60 * 60 * 1_000;
      expect(renewed.expiresAt).toBeGreaterThan(shortened.expiresAt! + 60 * dayMs);
      expect(renewed.expiresAt).toBeLessThan(shortened.expiresAt! + 61 * dayMs);
    },
  );

  it("persists peer pins and autonomy in shared plugin-state SQLite", async () => {
    const first = openReefTrustStore(runtime(), config());
    workerCommands = [];
    await first.set("clawd", peerTrust());
    expect(workerCommands).toHaveLength(1);
    workerCommands = [];
    await first.setAutonomy("clawd", "extended");
    expect(workerCommands).toHaveLength(1);

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.get("@clawd")).toMatchObject({
      autonomy: "extended",
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
    expect((await reopened.list()).map((entry) => entry.peer)).toEqual(["clawd"]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });

  it("preserves trust and rejection notices on released hosts without worker operations", async () => {
    const store = openReefTrustStore(runtime("legacy"), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const id = "01JZ0000000000000000000125";
    const binding = { bodyHash: "a".repeat(64), recipient };
    const notice = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
    await store.set("clawd", trustedPeer);
    await recordDelivery(store, "clawd", id, binding);
    expect(await rejectDelivery(store, "clawd", id)).toMatchObject({ category: "guard_deny" });
    const recovery = (await store.readOutboundDelivery("clawd", id))!.recovery;
    expect(await recovery.reserve(notice)).toEqual({
      kind: "reserved",
    });
    expect(await recovery.complete(notice)).toBe(true);

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.get("clawd")).toEqual(trustedPeer);
    expect(await reopened.rejectionNoticeState("clawd")).toEqual(notice);
    expect(await reopened.readOutboundDelivery("clawd", id)).toBeUndefined();
  });

  it("surfaces worker operation failures without applying a native fallback mutation", async () => {
    const store = openReefTrustStore(runtime(), config());
    await store.set("clawd", peerTrust());
    const failure = new Error("worker operation failed");
    beforeNextOperationWrite(() => {
      throw failure;
    });

    await expect(store.setAutonomy("clawd", "extended")).rejects.toBe(failure);
    expect(await openReefTrustStore(runtime(), config()).get("clawd")).toMatchObject({
      autonomy: "bounded",
    });
  });

  it("isolates trust by relay identity instead of machine-specific key paths", async () => {
    const molty = openReefTrustStore(runtime(), config("molty"));
    await molty.set("clawd", peerTrust());

    expect(await openReefTrustStore(runtime(), config("molty")).get("clawd")).toBeDefined();
    expect(await openReefTrustStore(runtime(), config("other")).get("clawd")).toBeUndefined();
    expect(
      await openReefTrustStore(runtime(), config("molty", "https://relay.example")).get("clawd"),
    ).toBeUndefined();
  });

  it("persists and consumes concurrent outbound request intents separately from active trust", async () => {
    const store = openReefTrustStore(runtime(), config());

    const first = await store.beginRequest("clawd", 123);
    const second = await store.beginRequest("clawd", 456);
    expect(first.requestId).not.toBe(second.requestId);
    expect(await openReefTrustStore(runtime(), config()).hasOutboundRequest("clawd")).toBe(true);
    expect(await store.get("clawd")).toBeUndefined();
    expect(await store.removeOutboundRequest("clawd", first.requestId)).toBe(true);
    expect(await first.status()).toBe("superseded");
    expect(await second.status()).toBe("current");
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
      const id = "01JZ0000000000000000000120";
      const trustedPeer = peerTrust();
      const recipient = reefPeerIdentity(trustedPeer);
      const binding = { bodyHash: "a".repeat(64), textHash: "b".repeat(64), recipient };
      const store = openReefTrustStore(runtime(), config());
      await store.set("clawd", trustedPeer);
      await recordDelivery(store, "clawd", id, binding);
      const settlement = (await store.readOutboundDelivery("clawd", id))!;
      const raw = runtime().state.openSyncKeyedStore({
        namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
        maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
      });
      const changed = {
        ...settlement.delivery,
        [field]: field === "recipient" ? reefPeerIdentity(peerTrust()) : "c".repeat(64),
      };
      raw.register(`${resolveReefTrustStoreKey(config(), "clawd")}:${id}`, changed);

      expect(await settlement.consume()).toBe("unavailable");
      const reopened = (await store.readOutboundDelivery("clawd", id))!;
      expect(reopened.delivery).toEqual(changed);
      expect(await reopened.consume()).toBe("consumed");
      expect(await store.readOutboundDelivery("clawd", id)).toBeUndefined();
    },
  );

  it("refuses an outbound delivery insert when channel authority closes before worker admission", async () => {
    const authority = new AbortController();
    const revoked = new Error("outbound authority closed");
    const store = openReefTrustStore(runtime(), config(), () => authority.signal.throwIfAborted());
    const trustedPeer = peerTrust();
    await store.set("clawd", trustedPeer);
    const id = "01JZ0000000000000000000126";
    const preparation = (await store.prepareOutboundDelivery("clawd", id))!;
    beforeNextOperationWrite(() => authority.abort(revoked));
    await expect(
      preparation.record({ bodyHash: "a".repeat(64), recipient: reefPeerIdentity(trustedPeer) }),
    ).rejects.toThrow("outbound authority closed");
    expect(
      await openReefTrustStore(runtime(), config()).readOutboundDelivery("clawd", id),
    ).toBeUndefined();
  });

  it.each(["worker", "legacy"] as const)(
    "refuses a prepared %s delivery after a sanctioned peer key rotation",
    async (host) => {
      const store = openReefTrustStore(runtime(host), config());
      const trustedPeer = peerTrust();
      await store.set("clawd", trustedPeer);
      const id = "01JZ0000000000000000000135";
      const preparation = (await store.prepareOutboundDelivery("clawd", id))!;
      const previous = await store.snapshot("clawd");
      nativePeerWriter().register(resolveReefTrustStoreKey(config(), "clawd"), {
        ...previous,
        revision: previous.revision + 1,
        trust: peerTrust(),
      });

      await expect(
        preparation.record({ bodyHash: "a".repeat(64), recipient: reefPeerIdentity(trustedPeer) }),
      ).rejects.toThrow("changed trust before dispatch");
      expect(await store.readOutboundDelivery("clawd", id)).toBeUndefined();
    },
  );

  it("revokes captured peer authority on sanctioned writes without another worker request", async () => {
    const store = openReefTrustStore(runtime(), config());
    await store.set("clawd", peerTrust());
    const observed = (await store.observePeer("clawd"))!;
    workerCommands = [];
    observed.assertCurrent();
    expect(workerCommands).toHaveLength(0);

    nativePeerWriter().register(resolveReefTrustStoreKey(config(), "clawd"), { revision: 2 });
    expect(() => observed.assertCurrent()).toThrow();
    expect(workerCommands).toHaveLength(0);
    expect(await store.get("clawd")).toBeUndefined();
  });

  it.each(["prepare", "read"] as const)(
    "rejects a borrowed delivery %s result after channel closure",
    async (operation) => {
      const authority = new AbortController();
      const revoked = new Error("delivery authority closed");
      const store = openReefTrustStore(runtime(), config(), () =>
        authority.signal.throwIfAborted(),
      );
      await store.set("clawd", peerTrust());
      nextOperationRead = () => authority.abort(revoked);
      await expect(
        operation === "prepare"
          ? store.prepareOutboundDelivery("clawd", "01JZ0000000000000000000136")
          : store.readOutboundDelivery("clawd", "01JZ0000000000000000000136"),
      ).rejects.toBe(revoked);
    },
  );

  it("preserves a rejection written after the accepted receipt read", async () => {
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    await store.set("clawd", trustedPeer);
    const id = "01JZ0000000000000000000137";
    await recordDelivery(store, "clawd", id, {
      bodyHash: "a".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    });
    const accepted = (await store.readOutboundDelivery("clawd", id))!;
    const raw = runtime().state.openSyncKeyedStore({
      namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
      maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
    });
    raw.register(`${resolveReefTrustStoreKey(config(), "clawd")}:${id}`, {
      ...accepted.delivery,
      rejection: { category: "guard_deny" },
    });

    expect(await accepted.consume()).toBe("rejected");
    expect((await store.readOutboundDelivery("clawd", id))?.delivery.rejection).toEqual({
      category: "guard_deny",
    });
  });

  it.each(["snapshot", "list"] as const)(
    "rejects a borrowed %s result after channel closure",
    async (read) => {
      const authority = new AbortController();
      const revoked = new Error("read authority closed");
      const store = openReefTrustStore(runtime(), config(), () =>
        authority.signal.throwIfAborted(),
      );
      nextOperationRead = () => authority.abort(revoked);
      await expect(read === "list" ? store.list() : store.snapshot("clawd")).rejects.toBe(revoked);
    },
  );

  it.each(["worker", "legacy"] as const)(
    "refuses an unaccepted %s removal and consumes accepted cleanup once",
    async (host) => {
      const persisted = openReefTrustStore(runtime(), config());
      await persisted.set("clawd", peerTrust());
      const before = await persisted.snapshot("clawd");
      let active = true;
      const revoked = new Error("removal authority closed");
      const store = openReefTrustStore(runtime(host), config(), () => {
        if (!active) {
          throw revoked;
        }
      });
      await expect(
        store.beginRemoval("clawd", () => {
          throw revoked;
        }),
      ).rejects.toBe(revoked);
      active = false;
      await expect(store.beginRemoval("clawd")).rejects.toBe(revoked);
      expect(await persisted.snapshot("clawd")).toEqual(before);

      active = true;
      const settle = await store.beginRemoval("clawd");
      active = false;
      (await persisted.beginRequest("clawd")).close();
      await settle();
      expect(await persisted.hasOutboundRequest("clawd")).toBe(false);
      (await persisted.beginRequest("clawd")).close();
      await expect(settle()).rejects.toThrow("already consumed");
      expect(await persisted.hasOutboundRequest("clawd")).toBe(true);
    },
  );

  it("keeps rejection notices durable until the sender agent consumes them", async () => {
    const id = "01JZ0000000000000000000121";
    const bodyHash = "a".repeat(64);
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const textHash = "c".repeat(64);
    const binding = { bodyHash, textHash, recipient };
    await store.set("clawd", trustedPeer);
    await recordDelivery(store, "clawd", id, binding);

    expect(await rejectDelivery(store, "clawd", id)).toMatchObject({ category: "guard_deny" });

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.pendingOutboundRejections()).toMatchObject([
      { id, peer: "clawd", recipient, textHash, category: "guard_deny" },
    ]);
    expect(await (await reopened.readOutboundDelivery("clawd", id))!.consume()).toBe("rejected");
    const noticeState = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
    const recovery = (await reopened.readOutboundDelivery("clawd", id))!.recovery;
    workerCommands = [];
    expect(await recovery.reserve(noticeState)).toEqual({
      kind: "reserved",
    });
    expect(workerCommands).toHaveLength(1);
    recovery.assertCurrent();
    expect(workerCommands).toHaveLength(1);
    expect(await reopened.pendingOutboundRejections()).toMatchObject([
      {
        id,
        peer: "clawd",
        recipient,
        textHash,
        category: "guard_deny",
        reservedNotice: noticeState,
      },
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
    const id = "01JZ0000000000000000000129";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    await store.set("clawd", trustedPeer);
    await recordDelivery(store, "clawd", id, binding, { resendDisabled: true });

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
    const id = "01JZ0000000000000000000124";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    await store.set("clawd", trustedPeer);
    await recordDelivery(store, "clawd", id, binding);
    await rejectDelivery(store, "clawd", id);

    const selected = (await store.pendingOutboundRejections())[0];
    if (!selected) {
      throw new Error("Expected a pending rejection before peer keys change");
    }
    const previous = await store.snapshot("clawd");
    const writer = nativePeerWriter();
    beforeNextOperationWrite(() =>
      writer.register(resolveReefTrustStoreKey(config(), "clawd"), {
        ...previous,
        revision: previous.revision + 1,
        trust: peerTrust(),
      }),
    );
    await expect(
      selected.recovery.reserve({
        lastRejectionAt: 10_000,
      }),
    ).rejects.toThrow("changed keys before rejection recovery");
    expect(await store.pendingOutboundRejections()).toMatchObject([]);
    expect(
      (await store.readOutboundDelivery("clawd", id))?.delivery.rejection?.notice,
    ).toBeUndefined();
  });

  it.each(["overdue", "rejections"] as const)(
    "observes sanctioned sibling writes between %s scans",
    async (kind) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      onTestFinished(() => clock.mockRestore());
      const mockRuntime = runtime();
      const store = openReefTrustStore(mockRuntime, config());
      const trust = peerTrust();
      const recipient = reefPeerIdentity(trust);
      const binding = { bodyHash: "a".repeat(64), recipient };
      await store.set("clawd", trust);
      await store.set("other", trust);
      await store.set("stranger", trust);
      const peers = ["clawd", "clawd", "other", "stranger", "clawd", "other", "stranger"];
      const ids = peers.map((_, index) => String(index + 1).padStart(26, "0"));
      for (const [index, peer] of peers.entries()) {
        clock.mockReturnValue(now + index);
        const id = ids[index];
        if (!id) {
          throw new Error("Missing fixture delivery id");
        }
        await recordDelivery(store, peer, id, binding);
        if (kind === "rejections") {
          await rejectDelivery(store, peer, id);
        }
      }
      await store.remove("stranger");
      const scan = async () =>
        kind === "overdue"
          ? await store.overdueOutboundDeliveries(600_000, Date.now() + 601_000)
          : await store.pendingOutboundRejections();
      expect((await scan()).map((entry) => entry.id)).toEqual([
        ids[0],
        ids[1],
        ids[2],
        ids[4],
        ids[5],
      ]);
      const writer = nativePeerWriter();
      writer.register(resolveReefTrustStoreKey(config(), "clawd"), { revision: 2 });
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
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    await store.set("clawd", trustedPeer);
    const latestId = "01JZ0000000000000000000122";
    const latestBinding = { bodyHash: "a".repeat(64), recipient };
    await recordDelivery(store, "clawd", latestId, latestBinding);
    await rejectDelivery(store, "clawd", latestId);
    const latestState = {
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    };
    const latestRecovery = (await store.readOutboundDelivery("clawd", latestId))!.recovery;
    await latestRecovery.reserve(latestState);
    const reopened = openReefTrustStore(runtime(), config());

    const olderId = "01JZ0000000000000000000123";
    const olderBinding = { bodyHash: "b".repeat(64), recipient };
    await recordDelivery(reopened, "clawd", olderId, olderBinding);
    await rejectDelivery(reopened, "clawd", olderId);
    const olderState = {
      lastRejectionAt: 9_000,
      lastResendAt: 9_100,
    };
    const olderRecovery = (await reopened.readOutboundDelivery("clawd", olderId))!.recovery;
    await olderRecovery.reserve(olderState);
    beforeNextOperationWrite(async () => {
      await latestRecovery.complete(latestState);
      await store.setAutonomy("clawd", "extended");
    });
    expect(await olderRecovery.complete(olderState)).toBe(true);
    expect(await reopened.get("clawd")).toMatchObject({ autonomy: "extended" });
    expect(await reopened.readOutboundDelivery("clawd", latestId)).toBeUndefined();
    expect(await reopened.readOutboundDelivery("clawd", olderId)).toBeUndefined();
    expect(await reopened.rejectionNoticeState("clawd")).toEqual({
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    });
  });

  it("rejects autonomy updates for untrusted or invalid peers", async () => {
    const store = openReefTrustStore(runtime(), config());

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
      let current = true;
      const revoked = new Error("trust authority revoked");
      const assertCurrent = () => {
        if (!current) {
          throw revoked;
        }
      };
      const store = openReefTrustStore(
        runtime(),
        config(),
        authority === "channel" ? assertCurrent : undefined,
      );
      await store.set("clawd", peerTrust());
      beforeNextOperationWrite(() => {
        current = false;
      });

      await expect(
        action === "autonomy"
          ? store.setAutonomy(
              "clawd",
              "extended",
              authority === "owner" ? assertCurrent : undefined,
            )
          : action === "removal"
            ? store.beginRemoval("clawd", authority === "owner" ? assertCurrent : undefined)
            : store.beginRequest("clawd", 123, authority === "owner" ? assertCurrent : undefined),
      ).rejects.toBe(revoked);
      expect(await openReefTrustStore(runtime(), config()).get("clawd")).toMatchObject({
        autonomy: "bounded",
      });
    },
  );

  it("updates autonomy atomically without overwriting concurrent safety state", async () => {
    const store = openReefTrustStore(runtime(), config());
    await store.set("clawd", peerTrust());
    const beforeSafetyChange = await store.snapshot("clawd");

    await store.setAutonomy("clawd", "extended");
    expect(await store.markSafetyNumberChanged("clawd", beforeSafetyChange.revision)).toBe(true);

    expect(await store.get("clawd")).toMatchObject({
      autonomy: "extended",
      safetyNumberChanged: true,
    });
  });

  it("preserves a concurrent autonomy update when repinning peer keys", async () => {
    const store = openReefTrustStore(runtime(), config());
    await store.set("clawd", peerTrust());
    const beforeRepin = await store.snapshot("clawd");
    const friend = relayFriend();

    await store.setAutonomy("clawd", "notify-only");
    expect(
      await store.commitPeerTrust(friend, { expectedRevision: beforeRepin.revision }, 123),
    ).toBe(true);

    expect(await store.get("clawd")).toMatchObject({
      autonomy: "notify-only",
      ed25519PublicKey: friend.ed25519_pub,
      approvedAt: 123,
    });
  });

  it("rejects a stale trust commit after local revocation", async () => {
    const store = openReefTrustStore(runtime(), config());
    const request = await store.beginRequest("clawd", 123);
    request.close();
    const requestId = request.requestId;
    const beforeRemoval = await store.snapshot("clawd");

    workerCommands = [];
    await store.remove("clawd");
    expect(workerCommands).toHaveLength(1);

    workerCommands = [];
    expect(
      await store.commitPeerTrust(relayFriend(), {
        expectedRevision: beforeRemoval.revision,
        expectedOutboundRequestId: requestId,
      }),
    ).toBe(false);
    expect(workerCommands).toHaveLength(1);
    expect(await store.get("clawd")).toBeUndefined();
    expect(await store.hasOutboundRequest("clawd")).toBe(false);
  });

  it("binds pairing approvals to the relay identity and exact peer keys", async () => {
    const identity = generateIdentity();
    const friend: RelayFriend = {
      peer: "clawd",
      status: "pending",
      initiated_by: "clawd",
      vouching_mutual: null,
      ed25519_pub: identity.signing.publicKey,
      x25519_pub: identity.encryption.publicKey,
      key_epoch: 2,
    };
    const molty = openReefTrustStore(runtime(), config("molty"));
    const token = molty.createPairingApproval(friend, (await molty.snapshot(friend.peer)).revision);

    expect(isReefPairingApprovalToken(token)).toBe(true);
    expect(molty.parsePairingApproval(token)).toEqual({
      peer: "clawd",
      keyEpoch: 2,
      trustRevision: 0,
    });
    expect(await molty.matchesPairingApproval(token, friend)).toBe(true);
    expect(openReefTrustStore(runtime(), config("other")).parsePairingApproval(token)).toBe(
      undefined,
    );
    expect(
      await molty.matchesPairingApproval(token, { ...friend, ed25519_pub: "C".repeat(43) }),
    ).toBe(false);

    await molty.remove("clawd");
    expect(await molty.matchesPairingApproval(token, friend)).toBe(false);
  });
});

describe("ReefTrustStore overdue outbound deliveries", () => {
  const OVERDUE_MS = 10 * 60 * 1_000;

  it("reports an unacknowledged delivery overdue exactly once", async () => {
    const id = "01JZ0000000000000000000140";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    await store.set("clawd", trustedPeer);
    const binding = {
      bodyHash: "a".repeat(64),
      textHash: "b".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    };
    await recordDelivery(store, "clawd", id, binding);

    expect(await store.overdueOutboundDeliveries(OVERDUE_MS)).toEqual([]);
    const later = Date.now() + OVERDUE_MS + 1_000;
    expect(await store.overdueOutboundDeliveries(OVERDUE_MS, later)).toMatchObject([
      { peer: "clawd", id },
    ]);

    expect(await store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(true);
    expect(await store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(false);
    expect(await store.overdueOutboundDeliveries(OVERDUE_MS, later)).toEqual([]);
  });

  it("excludes rejected and unpinned deliveries from the overdue sweep", async () => {
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    await store.set("clawd", trustedPeer);
    const later = Date.now() + OVERDUE_MS + 1_000;

    const rejectedId = "01JZ0000000000000000000141";
    const rejectedBinding = {
      bodyHash: "c".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    };
    await recordDelivery(store, "clawd", rejectedId, rejectedBinding);
    expect(await rejectDelivery(store, "clawd", rejectedId)).toMatchObject({
      category: "guard_deny",
    });

    const unpinnedId = "01JZ0000000000000000000142";
    await store.set("stranger", trustedPeer);
    await recordDelivery(store, "stranger", unpinnedId, {
      bodyHash: "d".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    });
    await store.remove("stranger");

    expect(await store.overdueOutboundDeliveries(OVERDUE_MS, later)).toEqual([]);
    expect(await store.markOutboundDeliveryOverdueNotified("clawd", rejectedId)).toBe(false);
  });
});
