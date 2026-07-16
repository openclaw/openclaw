import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateIdentity, MemoryAuditStore, MemoryReplayStore } from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  guard,
  peerTrust,
  reefKeys,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { reefMessageTextHash } from "./rejection-resend.js";
import { ReviewApprovalStore } from "./state.js";
import type { ReefTransportClient } from "./transport.js";

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
      stateDir: `/tmp/reef-flow-${randomUUID()}`,
      transport: relay as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(7)),
      replay: new MemoryReplayStore(),
      reviews: new ReviewApprovalStore(`/tmp/reef-reviews-${randomUUID()}`),
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
});
