import { PluginStateOperationInvalidatedError } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveGuardPolicyVersion, generateIdentity } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { isPermanentReefOutboundRejection, ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  workerFlowStores,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { reefMessageTextHash } from "./rejection-resend.js";
import { ReefTransportClient } from "./transport.js";

beforeEach(resetFlowStoresForTests);
afterEach(resetFlowStoresForTests);

async function fixture(rules?: { outbound: string }, fetcher?: typeof fetch) {
  const alice = reefKeys();
  const cfg = config();
  cfg.handle = "alice";
  if (rules) {
    cfg.guard!.rules = rules;
  }
  const policyVersion = effectiveGuardPolicyVersion("v1", cfg.guard!.rules);
  const guardMock = guard({ ...allow, policyVersion });
  const trustedPeer = peerTrust(generateIdentity());
  const { trusted, audit, ...stores } = await workerFlowStores(cfg, { bob: trustedPeer });
  const relay = transport();
  const flow = new ReefMessageFlow({
    config: cfg,
    trust: trusted,
    keys: alice,
    transport: fetcher
      ? new ReefTransportClient(cfg.relayUrl, "alice", alice, fetcher)
      : (relay as unknown as ReefTransportClient),
    guard: guardMock,
    audit,
    replay: new MemoryReplayStore(),
    ...stores,
    onIngress: async () => {},
    onOwnerNotice: async () => {},
  });
  return { flow, trusted, trustedPeer, relay, guardMock, policyVersion };
}

describe("ReefMessageFlow send recovery", () => {
  it("does not send to a peer revoked while delivery dispatch is prepared", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { flow, trusted } = await fixture(undefined, fetcher);

    const error = await flow
      .send("bob", "private coordination", {
        onPlatformSendDispatch: async () => {
          await trusted.remove("bob");
        },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PluginStateOperationInvalidatedError);
    expect(isPermanentReefOutboundRejection(error)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["automatic resend", "rules-bound policy"] as const)("sends with %s", async (mode) => {
    const resendDisabled = mode === "automatic resend" ? true : undefined;
    const rules = resendDisabled ? undefined : { outbound: "Never mention project Nightjar." };
    const { flow, trusted, trustedPeer, relay, guardMock, policyVersion } = await fixture(rules);
    const text = resendDisabled ? " rephrased coordination " : "meeting at ten";
    const id = await flow.send("bob", text, { resendDisabled });
    if (resendDisabled) {
      expect((await trusted.readOutboundDelivery("bob", id))?.delivery).toEqual({
        bodyHash: expect.any(String),
        textHash: reefMessageTextHash("rephrased coordination"),
        recipient: reefPeerIdentity(trustedPeer),
        resendDisabled: true,
        sentAt: expect.any(Number),
      });
    } else {
      expect(policyVersion).toMatch(/^v1\+[0-9a-f]{64}$/);
      expect(guardMock.classify).toHaveBeenCalledWith(expect.objectContaining({ policyVersion }));
    }
    expect(relay.sendEnvelope).toHaveBeenCalledOnce();
  });
});
