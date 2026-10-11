import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveGuardPolicyVersion, generateIdentity } from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
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
import { createReefOwnerNoticeHandler, notifyOverdueReefDeliveries } from "./owner-notice.js";
import { reefMessageTextHash } from "./rejection-resend.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

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

  it.each([false, true])(
    "handles an overdue first pairing send with current peer authority (revoked=%s)",
    async (revoked) => {
      const cfg = config();
      const stores = flowStores();
      const trusted = openReefTrustStore(stores.runtime, cfg);
      await trusted.set("alice", peerTrust(generateIdentity()));
      const sessionKey = "agent:main:reef:direct:alice";
      const sessionScope = {
        agentId: "main",
        sessionKey,
        env: { OPENCLAW_STATE_DIR: stores.stateDir },
      };
      expect(getSessionEntry(sessionScope)).toBeUndefined();
      const keys = reefKeys();
      const relay = new ReefTransportClient("https://reef.example", "bob", keys);
      const sendEnvelope = vi
        .spyOn(relay, "sendEnvelope")
        .mockImplementation(async (_peer, envelope) => ({
          id: envelope.id,
          status: "queued",
        }));
      const onIngress = vi.fn(async () => {});
      const flow = new ReefMessageFlow({
        config: cfg,
        trust: trusted,
        keys,
        transport: relay,
        guard: guard(allow),
        audit: openReefAuditStore(stores.runtime, new Uint8Array(32).fill(7)),
        replay: new MemoryReplayStore(),
        ...stores,
        onIngress,
        onOwnerNotice: async () => {},
      });
      const id = await flow.send("alice", PAIRING_APPROVED_MESSAGE);
      expect(sendEnvelope).toHaveBeenCalledOnce();
      expect(onIngress).not.toHaveBeenCalled();
      expect(getSessionEntry(sessionScope)).toBeUndefined();
      if (revoked) {
        await trusted.remove("alice");
      }
      const hostConfig: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { dmScope: "per-channel-peer" },
      };
      vi.mocked(stores.runtime.channel.routing.resolveAgentRoute).mockImplementation(
        resolveAgentRoute,
      );
      const ownerNotice = createReefOwnerNoticeHandler({
        runtime: stores.runtime,
        cfg: hostConfig,
        handle: "bob",
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 12 * 60_000);
      try {
        await notifyOverdueReefDeliveries({ trust: trusted, ownerNotice });
      } finally {
        clock.mockRestore();
      }
      if (revoked) {
        expect(stores.runtime.system.captureSessionEventTarget).not.toHaveBeenCalled();
        expect(stores.runtime.system.enqueueSessionEvent).not.toHaveBeenCalled();
      } else {
        expect(stores.runtime.system.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`Reef message ${id} to @alice has not been confirmed delivered`),
          expect.objectContaining({
            sessionKey,
            expectedTarget: expect.any(Object),
            createIfMissing: true,
          }),
        );
        expect(await trusted.overdueOutboundDeliveries(10 * 60_000)).toEqual([]);
      }
    },
  );

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
    const prepare = trusted.store.prepareOutboundDelivery.bind(trusted.store);
    vi.spyOn(trusted.store, "prepareOutboundDelivery").mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      if (!prepared) {
        return prepared;
      }
      return {
        ...prepared,
        async record(...recordArgs) {
          await prepared.record(...recordArgs);
          trusted.values.delete("bob");
        },
      };
    });
    const fetcher = vi.fn<typeof fetch>();
    const cfg = { ...config(), handle: "alice" };
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

    await expect(flow.send("bob", "meeting at ten")).rejects.toThrow(
      "changed trust before dispatch",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
