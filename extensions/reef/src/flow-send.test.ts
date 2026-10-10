import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveGuardPolicyVersion, generateIdentity } from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { isPermanentReefOutboundRejection, ReefMessageFlow } from "./flow.js";
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
import { ReefTransportClient } from "./transport.js";

beforeEach(resetFlowStoresForTests);
afterEach(resetFlowStoresForTests);

describe("ReefMessageFlow send recovery", () => {
  it("does not send to a peer revoked while delivery dispatch is prepared", async () => {
    const alice = reefKeys();
    const trusted = trust({ bob: peerTrust(generateIdentity()) });
    const fetcher = vi.fn<typeof fetch>();
    const cfg = config();
    cfg.handle = "alice";
    const flow = new ReefMessageFlow({
      config: cfg,
      trust: trusted.store,
      keys: alice,
      transport: new ReefTransportClient(cfg.relayUrl, "alice", alice, fetcher),
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      ...flowStores(),
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

    const error = await flow
      .send("bob", "private coordination", {
        onPlatformSendDispatch: async () => {
          trusted.values.delete("bob");
        },
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ message: "Reef peer @bob changed trust before dispatch" });
    expect(isPermanentReefOutboundRejection(error)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

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
});
