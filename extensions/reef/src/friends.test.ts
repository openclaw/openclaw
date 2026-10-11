import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { handleReefCommand } from "./commands.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefFriendManager } from "./friends.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import type { ReefTransportClient } from "./transport.js";
import { ReefRelayError } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function relayFriend(
  peer: string,
  status: RelayFriend["status"],
  identity = generateIdentity(),
  keyEpoch = 1,
  initiatedBy = peer,
): RelayFriend {
  return {
    peer,
    status,
    initiated_by: initiatedBy,
    vouching_mutual: null,
    key_epoch: keyEpoch,
    ed25519_pub: identity.signing.publicKey,
    x25519_pub: identity.encryption.publicKey,
  };
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
    return store;
  };
  return mockRuntime;
}

function config() {
  return ReefChannelConfigSchema.parse({ handle: "me" });
}

function trust() {
  return openReefTrustStore(runtime(), config());
}

function approvals(...initial: string[]): ConstructorParameters<typeof ReefFriendManager>[2] & {
  values: Set<string>;
  remove: ReturnType<typeof vi.fn>;
} {
  const values = new Set(initial);
  return {
    values,
    list: vi.fn(async () => [...values]),
    remove: vi.fn(async (peer: string) => values.delete(peer)),
  };
}

async function addApproval(
  store: ReturnType<typeof trust>,
  pairing: ReturnType<typeof approvals>,
  friend: RelayFriend,
): Promise<string> {
  const token = store.createPairingApproval(friend, (await store.snapshot(friend.peer)).revision);
  pairing.values.add(token);
  return token;
}

function transport(friend: RelayFriend) {
  return {
    handle: "me",
    listFriends: vi.fn(async () => ({ friendships: [friend] })),
    requestFriend: vi.fn(async () => ({ status: "pending" })),
    respondFriend: vi.fn(async (candidate: RelayFriend, accept: boolean) => {
      candidate.status = accept ? "active" : "blocked";
      return { peer: candidate.peer, status: candidate.status };
    }),
    removeFriend: vi.fn(async () => {
      friend.status = "blocked";
    }),
  };
}

function pairingFixture(friend: RelayFriend) {
  const relay = transport(friend);
  const store = trust();
  const pairing = approvals();
  const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);
  return { relay, store, pairing, manager };
}

describe("ReefFriendManager pairing", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-friends-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("surfaces an inbound request and consumes pairing approval into durable peer trust", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledWith({
      peer: "alice",
      fingerprint: expect.stringMatching(/^[0-9a-f ]+$/),
      code: "alice",
      approvalToken: store.createPairingApproval(
        pending,
        (await store.snapshot(pending.peer)).revision,
      ),
    });
    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();

    await addApproval(store, pairing, pending);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true, undefined);
    expect(await store.get("alice")).toMatchObject({
      autonomy: "bounded",
      ed25519PublicKey: pending.ed25519_pub,
      x25519PublicKey: pending.x25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("consumes approval before accepting or pinning an inbound friendship", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    pairing.remove.mockRejectedValue(new Error("approval store unavailable"));
    await addApproval(store, pairing, pending);

    await expect(manager.reconcile()).rejects.toThrow("approval store unavailable");
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(await store.get("alice")).toBeUndefined();
  });

  it("does not reuse an approval another reconciler already consumed", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    pairing.remove.mockResolvedValue(false);
    await addApproval(store, pairing, pending);

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(await store.get("alice")).toBeUndefined();
  });

  it("adopts a locally requested friendship once active and consumes its intent marker", async () => {
    const accepted = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const { store, manager } = pairingFixture(accepted);

    await manager.request("alice");
    expect(await store.hasOutboundRequest("alice")).toBe(true);
    accepted.status = "active";
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(await store.get("alice")).toMatchObject({ autonomy: "bounded", keyEpoch: 1 });
    expect(await store.hasOutboundRequest("alice")).toBe(false);

    const reopened = trust();
    expect(await reopened.get("alice")).toMatchObject({ autonomy: "bounded" });
    expect(fs.existsSync(path.join(stateDir, "requested.json"))).toBe(false);
  });

  it("preserves ambiguous outbound intent when account authority closes during a relay request", async () => {
    const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const requestStarted = deferred<void>();
    const relayResult = deferred<{ status: string }>();
    const relay = transport(pending);
    relay.requestFriend.mockImplementation(async () => {
      requestStarted.resolve(undefined);
      return await relayResult.promise;
    });
    const store = trust();
    const authority = new AbortController();
    const manager = new ReefFriendManager(
      relay as unknown as ReefTransportClient,
      store,
      approvals(),
      authority.signal,
    );
    const request = manager.request("alice");
    await requestStarted.promise;

    authority.abort();
    relayResult.resolve({ status: "pending" });

    await expect(request).rejects.toBeInstanceOf(Error);
    expect(await store.hasOutboundRequest("alice")).toBe(true);
  });

  it.each(["worker", "legacy"] as const)(
    "removes an unsent %s request intent after authority closes at commit acknowledgement",
    async (host) => {
      const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
      const relay = transport(pending);
      const authority = new AbortController();
      const store = openReefTrustStore(runtime(host), config(), () =>
        authority.signal.throwIfAborted(),
      );
      const beginRequest = store.beginRequest.bind(store);
      vi.spyOn(store, "beginRequest").mockImplementation(async (...args) => {
        const settlement = await beginRequest(...args);
        authority.abort(new Error("channel closed before dispatch"));
        return settlement;
      });
      const manager = new ReefFriendManager(
        relay as unknown as ReefTransportClient,
        store,
        approvals(),
        authority.signal,
      );

      await expect(manager.request("alice")).rejects.toThrow("channel closed before dispatch");
      expect(relay.requestFriend).not.toHaveBeenCalled();
      expect(await trust().hasOutboundRequest("alice")).toBe(false);
    },
  );

  it("rejects queued friendship commands after owner revocation and settles accepted intent", async () => {
    const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const requestStarted = deferred<void>();
    const relayResult = deferred<{ status: string }>();
    const relay = {
      ...transport(pending),
      mintFriendCode: vi.fn(async () => ({ code: "unused", expires: 1 })),
    };
    relay.requestFriend.mockImplementation(async () => {
      requestStarted.resolve(undefined);
      return await relayResult.promise;
    });
    const store = trust();
    const manager = new ReefFriendManager(
      relay as unknown as ReefTransportClient,
      store,
      approvals(),
    );
    const authority = createReefRuntimeAuthority();
    authority.activate({ friends: manager } as never);
    let ownerCurrent = true;
    const command = (args: string) =>
      handleReefCommand({
        args,
        senderIsOwner: true,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("owner revoked");
          }
        },
      });
    try {
      const accepted = command("friend request alice");
      await requestStarted.promise;
      const queued = Promise.allSettled([
        command("friend code"),
        command("friend request bob"),
        command("friend remove alice"),
        command("friend block alice"),
        command("friend autonomy alice extended"),
      ]);
      ownerCurrent = false;
      relayResult.resolve({ status: "pending" });
      await expect(accepted).resolves.toEqual({ text: "Reef friend request submitted." });
      for (const result of await queued) {
        expect(result).toMatchObject({ status: "rejected", reason: new Error("owner revoked") });
      }
      expect(await store.hasOutboundRequest("alice")).toBe(true);
      expect(await store.hasOutboundRequest("bob")).toBe(false);
      expect(relay.requestFriend).toHaveBeenCalledOnce();
      expect(relay.removeFriend).not.toHaveBeenCalled();
      expect(relay.mintFriendCode).not.toHaveBeenCalled();
      await expect(command("friend list")).resolves.toEqual({
        text: expect.stringContaining("@alice pending"),
      });
    } finally {
      relayResult.resolve({ status: "pending" });
      authority.release();
    }
  });

  it.each([
    ["worker", "accepted"],
    ["legacy", "accepted"],
    ["worker", "unknown"],
    ["legacy", "unknown"],
  ] as const)(
    "settles a revoked %s request after channel closure and a %s relay outcome",
    async (host, outcome) => {
      const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
      const requestStarted = deferred<void>();
      const relayResult = deferred<{ status: string }>();
      const requestingRelay = transport(pending);
      requestingRelay.requestFriend.mockImplementation(async () => {
        requestStarted.resolve(undefined);
        return await relayResult.promise;
      });
      const authority = new AbortController();
      const requester = new ReefFriendManager(
        requestingRelay as unknown as ReefTransportClient,
        openReefTrustStore(runtime(host), config(), () => authority.signal.throwIfAborted()),
        approvals(),
        authority.signal,
      );
      const remover = new ReefFriendManager(
        transport(pending) as unknown as ReefTransportClient,
        trust(),
        approvals(),
      );

      const request = requester.request("alice");
      const rejection = expect(request).rejects.toThrow(
        outcome === "accepted" ? "concurrently revoked" : "relay response lost",
      );
      await requestStarted.promise;
      await remover.remove("alice");
      authority.abort(new Error("channel closed"));
      if (outcome === "accepted") {
        relayResult.resolve({ status: "pending" });
      } else {
        relayResult.reject(new Error("relay response lost"));
      }

      await rejection;
      expect(requestingRelay.removeFriend).toHaveBeenCalledWith("alice");
      expect(await trust().hasOutboundRequest("alice")).toBe(false);
    },
  );

  it.each(["worker", "legacy"] as const)(
    "settles an accepted %s removal after channel closure and concurrent trust",
    async (host) => {
      const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
      const removalStarted = deferred<void>();
      const relayRemoval = deferred<void>();
      const removingRelay = transport(pending);
      const authority = new AbortController();
      removingRelay.removeFriend.mockImplementation(async () => {
        removalStarted.resolve(undefined);
        await relayRemoval.promise;
      });
      const remover = new ReefFriendManager(
        removingRelay as unknown as ReefTransportClient,
        openReefTrustStore(runtime(host), config(), () => authority.signal.throwIfAborted()),
        approvals(),
        authority.signal,
      );
      const requester = new ReefFriendManager(
        transport(pending) as unknown as ReefTransportClient,
        trust(),
        approvals(),
      );

      const removal = remover.remove("alice");
      const revoked = new Error("channel closed during relay removal");
      const settled = expect(removal).rejects.toBe(revoked);
      await removalStarted.promise;
      await expect(requester.request("alice")).resolves.toEqual({ status: "pending" });
      await requester.trust.set("alice", {
        autonomy: "bounded",
        ed25519PublicKey: pending.ed25519_pub,
        x25519PublicKey: pending.x25519_pub,
        keyEpoch: pending.key_epoch,
        safetyNumberChanged: false,
        approvedAt: 1,
      });
      expect(await trust().hasOutboundRequest("alice")).toBe(true);
      expect(await trust().get("alice")).toBeDefined();
      authority.abort(revoked);
      relayRemoval.resolve(undefined);
      await settled;

      expect(await trust().hasOutboundRequest("alice")).toBe(false);
      expect(await trust().get("alice")).toBeUndefined();
    },
  );

  it.each(["worker", "legacy"] as const)(
    "settles a rejected %s request after channel closure without erasing another intent",
    async (host) => {
      const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
      const requestStarted = deferred<void>();
      const relayResult = deferred<{ status: string }>();
      const rejectedRelay = transport(pending);
      rejectedRelay.requestFriend.mockImplementation(async () => {
        requestStarted.resolve(undefined);
        return await relayResult.promise;
      });
      const authority = new AbortController();
      const first = new ReefFriendManager(
        rejectedRelay as unknown as ReefTransportClient,
        openReefTrustStore(runtime(host), config(), () => authority.signal.throwIfAborted()),
        approvals(),
        authority.signal,
      );
      const second = new ReefFriendManager(
        transport(pending) as unknown as ReefTransportClient,
        trust(),
        approvals(),
      );

      const rejected = first.request("alice");
      const rejection = expect(rejected).rejects.toThrow("invalid request");
      await requestStarted.promise;
      const originalId = Object.keys((await trust().snapshot("alice")).outboundRequests ?? {})[0];
      await expect(second.request("alice")).resolves.toEqual({ status: "pending" });
      const retainedId = Object.keys((await trust().snapshot("alice")).outboundRequests ?? {}).find(
        (id) => id !== originalId,
      );
      authority.abort(new Error("channel closed"));
      relayResult.reject(new ReefRelayError(400, "invalid request"));
      await rejection;

      const reopened = trust();
      expect(await reopened.hasOutboundRequest("alice")).toBe(true);
      expect(Object.keys((await reopened.snapshot("alice")).outboundRequests ?? {})).toEqual([
        retainedId,
      ]);
      expect(rejectedRelay.removeFriend).not.toHaveBeenCalled();
    },
  );

  it("fails closed and requests approval for an active relay edge with no local intent", async () => {
    const accepted = relayFriend("alice", "active", generateIdentity(), 1, "me");
    const { manager } = pairingFixture(accepted);
    const issue = vi.fn(async () => {});

    await expect(manager.reconcile()).resolves.toEqual([]);
    await manager.surfacePairingCandidates(issue);

    expect(issue).toHaveBeenCalledOnce();
    expect(await manager.trust.get("alice")).toBeUndefined();
  });

  it("surfaces a reapproval edge with no local pin and does not duplicate an existing approval", async () => {
    const changed = relayFriend("alice", "reapprove_required");
    const { pairing, manager } = pairingFixture(changed);
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledOnce();

    await addApproval(manager.trust, pairing, changed);
    issue.mockClear();
    await manager.surfacePairingCandidates(issue);
    expect(issue).not.toHaveBeenCalled();
  });

  it("accepts reapprove_required with unchanged keys after a fresh bound approval", async () => {
    const reapproval = relayFriend("alice", "reapprove_required");
    const { relay, store, pairing, manager } = pairingFixture(reapproval);
    await store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: reapproval.ed25519_pub,
      x25519PublicKey: reapproval.x25519_pub,
      keyEpoch: reapproval.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledOnce();
    await addApproval(store, pairing, reapproval);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);

    expect(relay.respondFriend).toHaveBeenCalledWith(reapproval, true, undefined);
    expect(await store.get("alice")).toMatchObject({
      autonomy: "extended",
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("accepts an approved pending edge whose keys are already pinned", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    await store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: pending.ed25519_pub,
      x25519PublicKey: pending.x25519_pub,
      keyEpoch: pending.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    await addApproval(store, pairing, pending);

    await expect(manager.reconcile()).resolves.toEqual(["alice"]);

    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true, undefined);
    expect(await store.get("alice")).toMatchObject({ autonomy: "extended" });
    expect(pairing.values).toEqual(new Set());
  });

  it("does not recreate trust when local removal races an approved relay response", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    await addApproval(store, pairing, pending);
    relay.respondFriend.mockImplementation(async (friend: RelayFriend, accept: boolean) => {
      await store.remove(friend.peer);
      pending.status = accept ? "active" : "blocked";
      return { peer: friend.peer, status: pending.status };
    });

    await expect(manager.reconcile()).resolves.toEqual([]);

    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true, undefined);
    expect(relay.removeFriend).toHaveBeenCalledWith("alice");
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("halts on a key change, then repins only after a fresh approval", async () => {
    const oldIdentity = generateIdentity();
    const nextIdentity = generateIdentity();
    const active = relayFriend("alice", "active", nextIdentity, 2);
    const { store, pairing, manager } = pairingFixture(active);
    await store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: oldIdentity.signing.publicKey,
      x25519PublicKey: oldIdentity.encryption.publicKey,
      keyEpoch: 1,
      safetyNumberChanged: false,
      approvedAt: 1,
    });

    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(await store.get("alice")).toMatchObject({
      ed25519PublicKey: oldIdentity.signing.publicKey,
      keyEpoch: 1,
      safetyNumberChanged: true,
    });

    await addApproval(store, pairing, active);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(await store.get("alice")).toMatchObject({
      autonomy: "extended",
      ed25519PublicKey: nextIdentity.signing.publicKey,
      x25519PublicKey: nextIdentity.encryption.publicKey,
      keyEpoch: 2,
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("deletes stale approvals that have no actionable relay friendship", async () => {
    const blocked = relayFriend("alice", "blocked");
    const store = trust();
    const blockedToken = store.createPairingApproval(
      blocked,
      (await store.snapshot(blocked.peer)).revision,
    );
    const pairing = approvals(blockedToken, "missing");
    const manager = new ReefFriendManager(
      transport(blocked) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(pairing.remove).toHaveBeenCalledWith(blockedToken);
    expect(pairing.remove).toHaveBeenCalledWith("missing");
    expect(pairing.values).toEqual(new Set());
  });

  it("deletes malformed transient approval entries", async () => {
    const active = relayFriend("alice", "active");
    const pairing = approvals("not a handle");
    const manager = new ReefFriendManager(
      transport(active) as unknown as ReefTransportClient,
      trust(),
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(pairing.remove).toHaveBeenCalledWith("not a handle");
    expect(pairing.values).toEqual(new Set());
  });

  it("never treats an unbound generic allow entry as Reef authorization", async () => {
    const active = relayFriend("alice", "active");
    const pairing = approvals("alice");
    const store = trust();
    const manager = new ReefFriendManager(
      transport(active) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects a bound approval after the relay keys change", async () => {
    const active = relayFriend("alice", "active");
    const { store, pairing, manager } = pairingFixture(active);
    await addApproval(store, pairing, active);
    const nextIdentity = generateIdentity();
    active.ed25519_pub = nextIdentity.signing.publicKey;
    active.x25519_pub = nextIdentity.encryption.publicKey;
    active.key_epoch += 1;

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects a bound approval minted before local revocation", async () => {
    const pending = relayFriend("alice", "pending");
    const { store, pairing, manager } = pairingFixture(pending);
    await addApproval(store, pairing, pending);
    await store.remove("alice");

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects an approval when removal lands after validation but before snapshot", async () => {
    const pending = relayFriend("alice", "pending");
    const { relay, store, pairing, manager } = pairingFixture(pending);
    await addApproval(store, pairing, pending);
    const matchesApproval = store.matchesPairingApproval.bind(store);
    vi.spyOn(store, "matchesPairingApproval").mockImplementation(async (raw, friend) => {
      const matches = await matchesApproval(raw, friend);
      if (matches) {
        await store.remove(friend.peer);
      }
      return matches;
    });

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("revokes every local authorization source even when relay removal fails", async () => {
    const active = relayFriend("alice", "active");
    const { relay, store, pairing, manager } = pairingFixture(active);
    await addApproval(store, pairing, active);
    await store.set("alice", {
      autonomy: "bounded",
      ed25519PublicKey: active.ed25519_pub,
      x25519PublicKey: active.x25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    (await store.beginRequest("alice")).close();
    relay.removeFriend.mockImplementation(async () => {
      expect(await store.get("alice")).toBeUndefined();
      expect(await store.hasOutboundRequest("alice")).toBe(false);
      throw new ReefRelayError(503, "relay unavailable");
    });

    await expect(manager.remove("alice")).rejects.toThrow("relay unavailable");
    expect(await store.get("alice")).toBeUndefined();
    expect(await store.hasOutboundRequest("alice")).toBe(false);
    expect(pairing.values).toEqual(new Set());
  });

  it("attempts relay removal when transient approval cleanup fails", async () => {
    const active = relayFriend("alice", "active");
    const { relay, store, pairing, manager } = pairingFixture(active);
    await addApproval(store, pairing, active);
    await store.set("alice", {
      autonomy: "bounded",
      ed25519PublicKey: active.ed25519_pub,
      x25519PublicKey: active.x25519_pub,
      keyEpoch: active.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    pairing.remove.mockRejectedValue(new Error("approval store unavailable"));

    await expect(manager.remove("alice")).rejects.toThrow("approval store unavailable");

    expect(relay.removeFriend).toHaveBeenCalledWith("alice");
    expect(await store.get("alice")).toBeUndefined();
  });
});
