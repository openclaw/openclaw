import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalBytes,
  effectiveGuardPolicyVersion,
  generateIdentity,
  sha256Hex,
} from "../protocol/index.js";
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
    const stores = flowStores();
    const cfg = config();
    cfg.handle = "alice";
    const trustedPeer = peerTrust(bob);
    const trusted = trust(stores.runtime, cfg, { bob: trustedPeer });
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: cfg,
      trust: trusted,
      keys: alice,

      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...stores,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    const beforeSend = Date.now();
    const id = await flow.send("bob", " rephrased coordination ", { resendDisabled: true });
    const delivery = trusted.outboundDelivery("bob", id);

    expect(delivery).toEqual({
      bodyHash: sha256Hex(canonicalBytes({ text: " rephrased coordination " })),
      textHash: reefMessageTextHash("rephrased coordination"),
      recipient: reefPeerIdentity(trustedPeer),
      resendDisabled: true,
      sentAt: expect.any(Number),
    });
    expect(delivery?.sentAt).toBeGreaterThanOrEqual(beforeSend);
    expect(delivery?.sentAt).toBeLessThanOrEqual(Date.now());
    expect(relay.sendEnvelope).toHaveBeenCalledOnce();
  });

  it("classifies under the rules-bound effective guard policy version", async () => {
    const alice = reefKeys();
    const bob = generateIdentity();
    const stores = flowStores();
    const cfg = config();
    cfg.handle = "alice";
    cfg.guard!.rules = { outbound: "Never mention project Nightjar." };
    const policyVersion = effectiveGuardPolicyVersion("v1", cfg.guard!.rules);
    expect(policyVersion).toMatch(/^v1\+[0-9a-f]{64}$/);
    const guardMock = guard({ ...allow, policyVersion });
    const trusted = trust(stores.runtime, cfg, { bob: peerTrust(bob) });
    const relay = transport();
    const flow = new ReefMessageFlow({
      config: cfg,
      trust: trusted,
      keys: alice,
      transport: relay as unknown as ReefTransportClient,
      guard: guardMock,
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...stores,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    await flow.send("bob", "meeting at ten");

    expect(guardMock.classify).toHaveBeenCalledWith(expect.objectContaining({ policyVersion }));
    expect(relay.sendEnvelope).toHaveBeenCalledOnce();
  });
});
