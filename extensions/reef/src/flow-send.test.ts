import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveGuardPolicyVersion, generateIdentity } from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { reefMessageTextHash } from "./rejection-resend.js";
import type { ReefTransportClient } from "./transport.js";

beforeEach(resetFlowStoresForTests);
afterEach(resetFlowStoresForTests);

describe("ReefMessageFlow send recovery", () => {
  it("persists automatic resends as non-resendable deliveries", async () => {
    const alice = reefKeys();
    const bob = generateIdentity();
    const cfg = config();
    cfg.handle = "alice";
    const trustedPeer = peerTrust(bob);
    const trusted = trust({ bob: trustedPeer });
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: cfg,
      trust: trusted.store,
      keys: alice,

      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    const id = await flow.send("bob", " rephrased coordination ", { resendDisabled: true });

    expect(trusted.deliveries.get(`bob:${id}`)).toEqual({
      bodyHash: expect.any(String),
      textHash: reefMessageTextHash("rephrased coordination"),
      recipient: reefPeerIdentity(trustedPeer),
      resendDisabled: true,
    });
    expect(relay.sendEnvelope).toHaveBeenCalledOnce();
  });

  it("classifies under the rules-bound effective guard policy version", async () => {
    const alice = reefKeys();
    const bob = generateIdentity();
    const cfg = config();
    cfg.handle = "alice";
    cfg.guard!.rules = { outbound: "Never mention project Nightjar." };
    const policyVersion = effectiveGuardPolicyVersion("v1", cfg.guard!.rules);
    expect(policyVersion).toMatch(/^v1\+[0-9a-f]{64}$/);
    const guardMock = guard({ ...allow, policyVersion });
    const trusted = trust({ bob: peerTrust(bob) });
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: cfg,
      trust: trusted.store,
      keys: alice,
      transport: relay as unknown as ReefTransportClient,
      guard: guardMock,
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    await flow.send("bob", "meeting at ten");

    expect(guardMock.classify).toHaveBeenCalledWith(expect.objectContaining({ policyVersion }));
    expect(relay.sendEnvelope).toHaveBeenCalledOnce();
  });

  it("refuses delivery when peer trust is revoked during the final storage await", async () => {
    const alice = reefKeys();
    const trusted = trust({ bob: peerTrust(generateIdentity()) });
    const record = trusted.store.recordOutboundDelivery.bind(trusted.store);
    vi.spyOn(trusted.store, "recordOutboundDelivery").mockImplementation(async (...args) => {
      await record(...args);
      trusted.values.delete("bob");
    });
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: { ...config(), handle: "alice" },
      trust: trusted.store,
      keys: alice,
      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    await expect(flow.send("bob", "meeting at ten")).rejects.toThrow(
      "changed keys before delivery",
    );
    expect(relay.sendEnvelope).not.toHaveBeenCalled();
  });
});
