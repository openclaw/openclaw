import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { reefPeerIdentity } from "./friend-types.js";
import { isReefPairingApprovalToken, openReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;

function config(handle = "molty", relayUrl = "https://reefwire.ai") {
  return ReefChannelConfigSchema.parse({ handle, relayUrl });
}

function runtime() {
  const mockRuntime = createPluginRuntimeMock();
  mockRuntime.state.openKeyedStoreV2 = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority = { assertCurrent() {} },
  ) =>
    createPluginStateKeyedStoreV2ForTests<T>(
      "reef",
      {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      },
      authority,
    );
  mockRuntime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return mockRuntime;
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

describe("ReefTrustStore", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-trust-"));
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("retains delivery bindings across envelope and receipt relay windows", () => {
    const opened: OpenAsyncKeyedStoreOptions[] = [];
    const mockRuntime = createPluginRuntimeMock();
    mockRuntime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) => {
      opened.push(options);
      return createPluginStateKeyedStoreV2ForTests<T>(
        "reef",
        {
          ...options,
          env: { OPENCLAW_STATE_DIR: stateDir },
        },
        { assertCurrent() {} },
      );
    };

    openReefTrustStore(mockRuntime, config());

    expect(
      opened.find((options) => options.namespace === "outbound-deliveries")?.defaultTtlMs,
    ).toBe(61 * 24 * 60 * 60 * 1_000);
  });

  it("persists peer pins and autonomy in shared plugin-state SQLite", async () => {
    const first = openReefTrustStore(runtime(), config());
    await first.set("clawd", peerTrust());
    await first.setAutonomy("clawd", "extended");

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.get("@clawd")).toMatchObject({
      autonomy: "extended",
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
    expect((await reopened.list()).map((entry) => entry.peer)).toEqual(["clawd"]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
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

    const first = await store.recordOutboundRequest("clawd", 123);
    const second = await store.recordOutboundRequest("clawd", 456);
    expect(first).not.toBe(second);
    expect(await openReefTrustStore(runtime(), config()).hasOutboundRequest("clawd")).toBe(true);
    expect(await store.get("clawd")).toBeUndefined();
    expect(await store.removeOutboundRequest("clawd", first)).toBe(true);
    expect(await store.outboundRequestStatus("clawd", first)).toBe("superseded");
    expect(await store.outboundRequestStatus("clawd", second)).toBe("current");
    expect(await store.removeOutboundRequest("clawd", second)).toBe(true);
    expect(await store.hasOutboundRequest("clawd")).toBe(false);
    expect(await store.outboundRequestStatus("clawd", second)).toBe("revoked");
  });

  it("persists and atomically consumes outbound delivery bindings", async () => {
    const id = "01JZ0000000000000000000120";
    const bodyHash = "a".repeat(64);
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash, textHash: "b".repeat(64), recipient };
    const store = openReefTrustStore(runtime(), config());
    await store.set("clawd", trustedPeer);
    await store.recordOutboundDelivery("clawd", id, binding);

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.outboundDelivery("clawd", id)).toMatchObject(binding);
    expect(
      await reopened.consumeOutboundDelivery("clawd", id, { ...binding, bodyHash: "b".repeat(64) }),
    ).toBe(false);
    expect(
      await reopened.consumeOutboundDelivery("clawd", id, { ...binding, textHash: "c".repeat(64) }),
    ).toBe(false);
    expect(await reopened.outboundDelivery("clawd", id)).toMatchObject(binding);
    expect(await reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(true);
    expect(await reopened.outboundDelivery("clawd", id)).toBeUndefined();
    expect(await reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(false);
  });

  it("keeps rejection notices durable until the sender agent consumes them", async () => {
    const id = "01JZ0000000000000000000121";
    const bodyHash = "a".repeat(64);
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const textHash = "c".repeat(64);
    const binding = { bodyHash, textHash, recipient };
    await store.set("clawd", trustedPeer);
    await store.recordOutboundDelivery("clawd", id, binding);

    expect(
      await store.recordOutboundRejection(
        "clawd",
        id,
        { ...binding, bodyHash: "b".repeat(64) },
        "guard_deny",
      ),
    ).toBe(false);
    expect(await store.recordOutboundRejection("clawd", id, binding, "guard_deny")).toBe(true);

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.pendingOutboundRejections()).toEqual([
      { id, peer: "clawd", recipient, textHash, category: "guard_deny" },
    ]);
    expect(await reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(false);
    const noticeState = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
    expect(
      await reopened.reserveOutboundRejectionNotice("clawd", id, recipient, noticeState),
    ).toEqual({
      kind: "reserved",
    });
    expect(await reopened.pendingOutboundRejections()).toEqual([
      {
        id,
        peer: "clawd",
        recipient,
        textHash,
        category: "guard_deny",
        reservedNotice: noticeState,
      },
    ]);
    expect(await reopened.completeOutboundRejection("clawd", id, noticeState)).toBe(true);
    expect(await reopened.pendingOutboundRejections()).toEqual([]);
    expect(await reopened.outboundDelivery("clawd", id)).toBeUndefined();
    expect(await reopened.rejectionNoticeState("clawd")).toEqual(noticeState);
    expect(await reopened.completeOutboundRejection("clawd", id, noticeState)).toBe(true);
  });

  it("marks imported delivery rejections stop-only in the atomic receipt update", async () => {
    const id = "01JZ0000000000000000000129";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    await store.set("clawd", trustedPeer);
    await store.recordOutboundDelivery("clawd", id, binding, { resendDisabled: true });

    expect(await store.recordOutboundRejection("clawd", id, binding, "guard_deny")).toBe(true);
    expect(await store.pendingOutboundRejections()).toEqual([
      {
        id,
        peer: "clawd",
        recipient,
        category: "guard_deny",
        reservedNotice: { lastRejectionAt: expect.any(Number) },
      },
    ]);
  });

  it("does not recover a rejected delivery after the peer identity changes", async () => {
    const id = "01JZ0000000000000000000124";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    await store.set("clawd", trustedPeer);
    await store.recordOutboundDelivery("clawd", id, binding);
    await store.recordOutboundRejection("clawd", id, binding, "guard_deny");

    const selected = (await store.pendingOutboundRejections())[0];
    if (!selected) {
      throw new Error("Expected a pending rejection before peer keys change");
    }
    await store.set("clawd", peerTrust());

    expect(await store.pendingOutboundRejections()).toEqual([]);
    await expect(
      store.reserveOutboundRejectionNotice(selected.peer, selected.id, selected.recipient, {
        lastRejectionAt: 10_000,
      }),
    ).rejects.toThrow("changed keys before rejection recovery");
  });

  it.each(["overdue", "rejections"] as const)(
    "bounds repeated peer reads in %s scans and refreshes between scans",
    async (kind) => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      onTestFinished(() => clock.mockRestore());
      const mockRuntime = runtime();
      const openStore = mockRuntime.state.openKeyedStoreV2;
      let peerReads = 0;
      mockRuntime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) => {
        const keyedStore = openStore<T>(options);
        if (options.namespace === "peer-state") {
          const entries = keyedStore.entries.bind(keyedStore);
          keyedStore.entries = () => {
            peerReads += 1;
            return entries();
          };
        }
        return keyedStore;
      };
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
        await store.recordOutboundDelivery(peer, id, binding);
        if (kind === "rejections") {
          await store.recordOutboundRejection(peer, id, binding, "guard_deny");
        }
      }
      await store.remove("stranger");
      const scan = async () =>
        kind === "overdue"
          ? await store.overdueOutboundDeliveries(600_000, Date.now() + 601_000)
          : await store.pendingOutboundRejections();
      peerReads = 0;
      expect((await scan()).map((entry) => entry.id)).toEqual([
        ids[0],
        ids[1],
        ids[2],
        ids[4],
        ids[5],
      ]);
      expect(peerReads).toBeGreaterThan(0);
      expect(peerReads).toBeLessThanOrEqual(3);
      await store.remove("clawd");
      expect((await scan()).map((entry) => entry.id)).toEqual([ids[2], ids[5]]);
      await store.set("stranger", trust);
      expect((await scan()).map((entry) => entry.id)).toEqual([ids[2], ids[3], ids[5], ids[6]]);
      await store.set("other", { ...trust, safetyNumberChanged: true });
      expect((await scan()).map((entry) => entry.id)).toEqual([ids[3], ids[6]]);
    },
  );

  it("persists restart-stable rejection notice cooldowns monotonically", async () => {
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    await store.set("clawd", trustedPeer);
    const latestId = "01JZ0000000000000000000122";
    const latestBinding = { bodyHash: "a".repeat(64), recipient };
    await store.recordOutboundDelivery("clawd", latestId, latestBinding);
    await store.recordOutboundRejection("clawd", latestId, latestBinding, "guard_deny");
    const latestState = {
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    };
    await store.reserveOutboundRejectionNotice("clawd", latestId, recipient, latestState);
    await store.completeOutboundRejection("clawd", latestId, latestState);

    const reopened = openReefTrustStore(runtime(), config());
    expect(await reopened.rejectionNoticeState("clawd")).toEqual({
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    });

    const olderId = "01JZ0000000000000000000123";
    const olderBinding = { bodyHash: "b".repeat(64), recipient };
    await reopened.recordOutboundDelivery("clawd", olderId, olderBinding);
    await reopened.recordOutboundRejection("clawd", olderId, olderBinding, "guard_deny");
    const olderState = {
      lastRejectionAt: 9_000,
      lastResendAt: 9_100,
    };
    await reopened.reserveOutboundRejectionNotice("clawd", olderId, recipient, olderState);
    await reopened.completeOutboundRejection("clawd", olderId, olderState);
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

    const compare = store.stores.peers.compareAndApply.bind(store.stores.peers);
    vi.spyOn(store.stores.peers, "compareAndApply").mockImplementationOnce(async (...args) => {
      await store.setAutonomy("clawd", "notify-only");
      return compare(...args);
    });
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
    const requestId = await store.recordOutboundRequest("clawd", 123);
    const beforeRemoval = await store.snapshot("clawd");

    await store.remove("clawd");

    expect(
      await store.commitPeerTrust(relayFriend(), {
        expectedRevision: beforeRemoval.revision,
        expectedOutboundRequestId: requestId,
      }),
    ).toBe(false);
    expect(await store.get("clawd")).toBeUndefined();
    expect(await store.hasOutboundRequest("clawd")).toBe(false);
  });

  it.each(["delivery", "rejection notice"] as const)(
    "refuses a %s mutation when trust is revoked after preparation",
    async (kind) => {
      const store = openReefTrustStore(runtime(), config());
      const trustedPeer = peerTrust();
      const recipient = reefPeerIdentity(trustedPeer);
      const id = "01JZ0000000000000000000125";
      const binding = { bodyHash: "a".repeat(64), recipient };
      await store.set("clawd", trustedPeer);
      if (kind === "rejection notice") {
        await store.recordOutboundDelivery("clawd", id, binding);
        await store.recordOutboundRejection("clawd", id, binding, "guard_deny");
      }
      const compare = store.stores.deliveries.compareAndApply.bind(store.stores.deliveries);
      vi.spyOn(store.stores.deliveries, "compareAndApply").mockImplementationOnce(
        async (...args) => {
          await store.remove("clawd");
          return compare(...args);
        },
      );
      const mutation =
        kind === "delivery"
          ? store.recordOutboundDelivery("clawd", id, binding)
          : store.reserveOutboundRejectionNotice("clawd", id, recipient, { lastRejectionAt: 123 });
      await expect(mutation).rejects.toThrow("changed keys before");
      const delivery = await store.outboundDelivery("clawd", id);
      if (kind === "delivery") {
        expect(delivery).toBeUndefined();
      } else {
        expect(delivery?.rejection?.notice).toBeUndefined();
      }
    },
  );

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
    const token = await molty.createPairingApproval(friend);

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
    await store.recordOutboundDelivery("clawd", id, binding);

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
    await store.recordOutboundDelivery("clawd", rejectedId, rejectedBinding);
    expect(
      await store.recordOutboundRejection("clawd", rejectedId, rejectedBinding, "guard_deny"),
    ).toBe(true);

    const unpinnedId = "01JZ0000000000000000000142";
    const stranger = peerTrust();
    await store.set("stranger", stranger);
    await store.recordOutboundDelivery("stranger", unpinnedId, {
      bodyHash: "d".repeat(64),
      recipient: reefPeerIdentity(stranger),
    });
    await store.remove("stranger");

    expect(await store.overdueOutboundDeliveries(OVERDUE_MS, later)).toEqual([]);
    expect(await store.markOutboundDeliveryOverdueNotified("clawd", rejectedId)).toBe(false);
  });
});
