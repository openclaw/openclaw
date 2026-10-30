import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { handleReefCommand } from "./commands.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefFriendManager } from "./friends.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import {
  cleanupStateTestDirectory,
  createRuntime,
  createStateTestDirectory,
} from "./state.test-support.js";
import type { ReefTransportClient } from "./transport.js";
import { ReefRelayError } from "./transport.js";
import { openReefTrustStore, type ReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;

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

function trust(signal?: AbortSignal) {
  return openReefTrustStore(
    createRuntime(stateDir),
    ReefChannelConfigSchema.parse({ handle: "me" }),
    signal ? () => signal.throwIfAborted() : undefined,
  );
}

function approvals(...initial: string[]): ConstructorParameters<typeof ReefFriendManager>[2] & {
  values: Set<string>;
  list: ReturnType<typeof vi.fn>;
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

function pairingFixture(
  friend = relayFriend("alice", "pending"),
  signal?: AbortSignal,
  pairing = approvals(),
  store = trust(signal),
) {
  const relay = {
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
  const manager = new ReefFriendManager(
    relay as unknown as ReefTransportClient,
    store,
    pairing,
    signal,
  );
  return { friend, relay, store, pairing, manager };
}

const outgoing = () => relayFriend("alice", "pending", generateIdentity(), 1, "me");

function heldRequest(friend = outgoing(), signal?: AbortSignal, store = trust(signal)) {
  const fixture = pairingFixture(friend, signal, approvals(), store);
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ status: string }>();
  fixture.relay.requestFriend.mockImplementation(async () => {
    started.resolve(undefined);
    return await result.promise;
  });
  return { ...fixture, started: started.promise, result };
}

function pin(store: ReefTrustStore, friend: RelayFriend, autonomy: "bounded" | "extended") {
  return store.set(friend.peer, {
    autonomy,
    ed25519PublicKey: friend.ed25519_pub,
    x25519PublicKey: friend.x25519_pub,
    keyEpoch: friend.key_epoch,
    safetyNumberChanged: false,
    approvedAt: 1,
  });
}

describe("ReefFriendManager pairing", () => {
  beforeEach(() => {
    stateDir = createStateTestDirectory();
  });
  afterEach(() => cleanupStateTestDirectory(stateDir));

  it.each([false, true])("reads pairing once per lifecycle tick (pending=%s)", async (pending) => {
    const { relay, pairing, manager } = pairingFixture();
    if (!pending) {
      relay.listFriends.mockResolvedValue({ friendships: [] });
    }
    const issue = vi.fn(async () => {});
    await manager.reconcile(undefined, issue);
    expect(issue).toHaveBeenCalledTimes(pending ? 1 : 0);
    expect(relay.listFriends).toHaveBeenCalledTimes(2);
    expect(pairing.list).toHaveBeenCalledOnce();
  });

  it("surfaces an inbound request and consumes pairing approval into durable peer trust", async () => {
    const { friend: pending, relay, store, pairing, manager } = pairingFixture();
    const issue = vi.fn(async () => {});
    await manager.reconcile(undefined, issue);
    const { revision } = await store.snapshot(pending.peer);
    expect(issue).toHaveBeenCalledWith({
      peer: "alice",
      fingerprint: expect.stringMatching(/^[0-9a-f ]+$/),
      code: "alice",
      approvalToken: store.createPairingApproval(pending, revision),
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

  it("does not reuse an approval another reconciler already consumed", async () => {
    const { friend: pending, relay, store, pairing, manager } = pairingFixture();
    pairing.remove.mockResolvedValue(false);
    await addApproval(store, pairing, pending);
    const issue = vi.fn(async () => {});
    await expect(manager.reconcile(undefined, issue)).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(await store.get("alice")).toBeUndefined();
    expect(issue).toHaveBeenCalledOnce();
  });

  it("defers a newly added approval to the next reconciliation", async () => {
    const { friend, relay, store, pairing, manager } = pairingFixture();
    const issue = vi.fn(async () => {});
    relay.listFriends
      .mockResolvedValueOnce({ friendships: [friend] })
      .mockImplementationOnce(async () => {
        await addApproval(store, pairing, friend);
        return { friendships: [friend] };
      });
    await expect(manager.reconcile(undefined, issue)).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledOnce();
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(await store.get("alice")).toBeDefined();
  });

  it("adopts a locally requested friendship once active and consumes its intent marker", async () => {
    const accepted = outgoing();
    const { store, manager } = pairingFixture(accepted);
    await manager.request("alice");
    expect(await store.hasOutboundRequest("alice")).toBe(true);
    accepted.status = "active";
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(await store.get("alice")).toMatchObject({ autonomy: "bounded", keyEpoch: 1 });
    expect(await store.hasOutboundRequest("alice")).toBe(false);

    expect(await trust().get("alice")).toMatchObject({ autonomy: "bounded" });
    expect(fs.existsSync(path.join(stateDir, "requested.json"))).toBe(false);
  });

  it("preserves ambiguous outbound intent when account authority closes during a relay request", async () => {
    const authority = new AbortController();
    const { manager, store, started, result } = heldRequest(outgoing(), authority.signal, trust());
    const request = manager.request("alice");
    await started;

    authority.abort();
    result.resolve({ status: "pending" });
    await expect(request).rejects.toBeInstanceOf(Error);
    expect(await store.hasOutboundRequest("alice")).toBe(true);
  });

  it("removes an unsent request intent after authority closes at commit acknowledgement", async () => {
    const authority = new AbortController();
    const { relay, store, manager } = pairingFixture(outgoing(), authority.signal);
    const beginRequest = store.beginRequest.bind(store);
    vi.spyOn(store, "beginRequest").mockImplementation(async (...args) => {
      const settlement = await beginRequest(...args);
      authority.abort(new Error("channel closed before dispatch"));
      return settlement;
    });
    await expect(manager.request("alice")).rejects.toThrow("channel closed before dispatch");
    expect(relay.requestFriend).not.toHaveBeenCalled();
    expect(await trust().hasOutboundRequest("alice")).toBe(false);
  });

  it("rejects queued friendship commands after owner revocation and settles accepted intent", async () => {
    const { manager, store, relay: baseRelay, started, result } = heldRequest();
    const relay = Object.assign(baseRelay, {
      mintFriendCode: vi.fn(async () => ({ code: "unused", expires: 1 })),
    });
    const authority = createReefRuntimeAuthority();
    authority.activate({ friends: manager } as never);
    const owner = new AbortController();
    const command = (args: string) =>
      handleReefCommand({
        args,
        senderIsOwner: true,
        assertOwnerCurrent: () => owner.signal.throwIfAborted(),
      });
    try {
      const accepted = command("friend request alice");
      await started;
      const queued = Promise.allSettled([
        command("friend code"),
        command("friend request bob"),
        command("friend remove alice"),
        command("friend block alice"),
        command("friend autonomy alice extended"),
      ]);
      owner.abort(new Error("owner revoked"));
      result.resolve({ status: "pending" });
      await expect(accepted).resolves.toEqual({ text: "Reef friend request submitted." });
      for (const entry of await queued) {
        expect(entry).toMatchObject({ status: "rejected", reason: new Error("owner revoked") });
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
      result.resolve({ status: "pending" });
      authority.release();
    }
  });

  it.each(["accepted", "unknown"] as const)(
    "settles a revoked request after channel closure and a %s relay outcome",
    async (outcome) => {
      const pending = outgoing();
      const authority = new AbortController();
      const { manager, relay, started, result } = heldRequest(pending, authority.signal);
      const { manager: remover } = pairingFixture(pending);

      const request = manager.request("alice");
      const rejection = expect(request).rejects.toThrow(
        outcome === "accepted" ? "concurrently revoked" : "relay response lost",
      );
      await started;
      await remover.remove("alice");
      authority.abort(new Error("channel closed"));
      if (outcome === "accepted") {
        result.resolve({ status: "pending" });
      } else {
        result.reject(new Error("relay response lost"));
      }
      await rejection;
      expect(relay.removeFriend).toHaveBeenCalledWith("alice");
      expect(await trust().hasOutboundRequest("alice")).toBe(false);
    },
  );

  it("settles an accepted removal after channel closure and concurrent trust", async () => {
    const pending = outgoing();
    const removalStarted = Promise.withResolvers<void>();
    const relayRemoval = Promise.withResolvers<void>();
    const authority = new AbortController();
    const { relay: removingRelay, manager: remover } = pairingFixture(pending, authority.signal);
    removingRelay.removeFriend.mockImplementation(async () => {
      removalStarted.resolve(undefined);
      await relayRemoval.promise;
    });
    const { manager: requester } = pairingFixture(pending);

    const removal = remover.remove("alice");
    const revoked = new Error("channel closed during relay removal");
    const settled = expect(removal).rejects.toBe(revoked);
    await removalStarted.promise;
    await expect(requester.request("alice")).resolves.toEqual({ status: "pending" });
    await pin(requester.trust, pending, "bounded");
    expect(await trust().hasOutboundRequest("alice")).toBe(true);
    expect(await trust().get("alice")).toBeDefined();
    authority.abort(revoked);
    relayRemoval.resolve(undefined);
    await settled;
    expect(await trust().hasOutboundRequest("alice")).toBe(false);
    expect(await trust().get("alice")).toBeUndefined();
  });

  it("settles a rejected request after channel closure without erasing another intent", async () => {
    const pending = outgoing();
    const authority = new AbortController();
    const { manager, relay, started, result } = heldRequest(pending, authority.signal);
    const { manager: second } = pairingFixture(pending);

    const rejection = expect(manager.request("alice")).rejects.toThrow("invalid request");
    await started;
    const originalId = Object.keys((await trust().snapshot("alice")).outboundRequests ?? {})[0];
    await expect(second.request("alice")).resolves.toEqual({ status: "pending" });
    const retainedId = Object.keys((await trust().snapshot("alice")).outboundRequests ?? {}).find(
      (id) => id !== originalId,
    );
    authority.abort(new Error("channel closed"));
    result.reject(new ReefRelayError(400, "invalid request"));
    await rejection;

    const reopened = trust();
    expect(await reopened.hasOutboundRequest("alice")).toBe(true);
    expect(Object.keys((await reopened.snapshot("alice")).outboundRequests ?? {})).toEqual([
      retainedId,
    ]);
    expect(relay.removeFriend).not.toHaveBeenCalled();
  });

  it("fails closed and requests approval for an active relay edge with no local intent", async () => {
    const { manager } = pairingFixture(relayFriend("alice", "active", generateIdentity(), 1, "me"));
    const issue = vi.fn(async () => {});
    await expect(manager.reconcile()).resolves.toEqual([]);
    await manager.reconcile(undefined, issue);
    expect(issue).toHaveBeenCalledOnce();
    expect(await manager.trust.get("alice")).toBeUndefined();
  });

  it("surfaces a reapproval edge with no local pin and does not duplicate an existing approval", async () => {
    const changed = relayFriend("alice", "reapprove_required");
    const { pairing, manager } = pairingFixture(changed);
    const issue = vi.fn(async () => {});
    await manager.reconcile(undefined, issue);
    expect(issue).toHaveBeenCalledOnce();
    await addApproval(manager.trust, pairing, changed);
    issue.mockClear();
    await manager.reconcile(undefined, issue);
    expect(issue).not.toHaveBeenCalled();
  });

  it.each(["pending", "reapprove_required"] as const)(
    "accepts an approved %s edge whose keys are already pinned",
    async (status) => {
      const { friend, relay, store, pairing, manager } = pairingFixture(
        relayFriend("alice", status),
      );
      await pin(store, friend, "extended");
      const issue = vi.fn(async () => {});
      await manager.reconcile(undefined, issue);
      expect(issue).toHaveBeenCalledOnce();
      await addApproval(store, pairing, friend);
      relay.listFriends
        .mockResolvedValueOnce({ friendships: [{ ...friend }] })
        .mockResolvedValue({ friendships: [{ ...friend, status: "active" }] });
      relay.respondFriend.mockResolvedValue({ peer: friend.peer, status: "active" });
      issue.mockClear();
      await expect(manager.reconcile(undefined, issue)).resolves.toEqual(["alice"]);
      expect(relay.respondFriend).toHaveBeenCalledWith(friend, true, undefined);
      expect(issue).not.toHaveBeenCalled();
      expect(await store.get("alice")).toMatchObject({
        autonomy: "extended",
        safetyNumberChanged: false,
      });
      expect(pairing.values).toEqual(new Set());
    },
  );

  it("does not recreate trust when local removal races an approved relay response", async () => {
    const { friend: pending, relay, store, pairing, manager } = pairingFixture();
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
    await pin(store, relayFriend("alice", "active", oldIdentity), "extended");
    const issue = vi.fn(async () => {});
    await expect(manager.reconcile(undefined, issue)).resolves.toEqual(["alice"]);
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalToken: store.createPairingApproval(
          active,
          (await store.snapshot("alice")).revision,
        ),
      }),
    );
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
    const { manager, store, pairing } = pairingFixture(blocked);
    const blockedToken = await addApproval(store, pairing, blocked);
    pairing.values.add("missing");
    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(pairing.remove).toHaveBeenCalledWith(blockedToken);
    expect(pairing.remove).toHaveBeenCalledWith("missing");
    expect(pairing.values).toEqual(new Set());
  });

  it("never treats an unbound generic allow entry as Reef authorization", async () => {
    const { pairing, store, manager } = pairingFixture(
      relayFriend("alice", "active"),
      undefined,
      approvals("alice"),
    );
    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects a bound approval minted before local revocation", async () => {
    const { friend: pending, store, pairing, manager } = pairingFixture();
    await addApproval(store, pairing, pending);
    await store.remove("alice");
    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(await store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects an approval when removal lands after validation but before snapshot", async () => {
    const { friend: pending, relay, store, pairing, manager } = pairingFixture();
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
    await pin(store, active, "bounded");
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
    await pin(store, active, "bounded");
    pairing.remove.mockRejectedValue(new Error("approval store unavailable"));
    await expect(manager.remove("alice")).rejects.toThrow("approval store unavailable");
    expect(relay.removeFriend).toHaveBeenCalledWith("alice");
    expect(await store.get("alice")).toBeUndefined();
  });
});
