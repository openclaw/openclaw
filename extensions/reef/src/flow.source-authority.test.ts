import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  envelope,
  flowRuntime,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import { ReefDeliveredStore, ReviewApprovalStore } from "./state.js";
import { cleanupStateTestDirectory, createStateTestDirectory } from "./state.test-support.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

let directory: string;
const id = "01JZ0000000000000000000160";
beforeEach(async () => {
  await resetFlowStoresForTests();
  directory = createStateTestDirectory();
});
afterEach(() => cleanupStateTestDirectory(directory));

it.each(["outbound", "inbound", "recovery"] as const)(
  "Reef captured source authority refuses %s effects after revocation and rerouting",
  async (direction) => {
    const originalEnv = { OPENCLAW_STATE_DIR: path.join(directory, "original") };
    const alternateEnv = { OPENCLAW_STATE_DIR: path.join(directory, "alternate") };
    const movingEnv = { ...originalEnv };
    const cfg = config();
    const peer = generateIdentity();
    const keys = reefKeys();
    const original = openReefTrustStore(flowRuntime(originalEnv), cfg);
    const alternate = openReefTrustStore(flowRuntime(alternateEnv), cfg);
    await original.set("alice", peerTrust(peer));
    await alternate.set("alice", peerTrust(peer));
    const currentRuntime = flowRuntime(movingEnv);
    const trust = openReefTrustStore(currentRuntime, cfg);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("unexpected relay request"));
    const ingress = vi.fn(async () => {});
    const delivered = new ReefDeliveredStore(currentRuntime);
    const revokeAndReroute = async () => {
      await original.remove("alice");
      movingEnv.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
    };
    const flow = new ReefMessageFlow({
      config: cfg,
      trust,
      keys,
      transport: new ReefTransportClient(cfg.relayUrl, cfg.handle!, keys, fetcher),
      guard: guard(allow),
      audit: openReefAuditStore(currentRuntime, new Uint8Array(32).fill(8)),
      replay: new MemoryReplayStore(),
      reviews: new ReviewApprovalStore(currentRuntime),
      delivered,
      onIngress: async (_message, assertCurrent) => {
        assertCurrent();
        await ingress();
      },
      onOwnerNotice: async () => {},
    });
    if (direction === "recovery") {
      const deliveryKey = `${trust.operationState.identityScope}:alice:${id}`;
      await trust.operationState.deliveries.register(deliveryKey, {
        bodyHash: "a".repeat(64),
        sentAt: Date.now(),
        recipient: reefPeerIdentity(peerTrust(peer)),
      });
      const delivery = (await trust.readOutboundDelivery("alice", id))!;
      await delivery.reject("guard_deny");
      const { recovery } = delivery;
      movingEnv.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
      const notice = { lastRejectionAt: 10_000 };
      await expect(recovery.reserve(notice)).resolves.toEqual({ kind: "reserved" });
      expect(
        (await original.readOutboundDelivery("alice", id))?.delivery.rejection?.notice,
      ).toEqual(notice);
      expect(await recovery.complete(notice)).toBe(true);
      expect(await original.readOutboundDelivery("alice", id)).toBeUndefined();
      await expect(
        flow.send("alice", "rephrased coordination", {
          recovery,
          onPlatformSendDispatch: revokeAndReroute,
        }),
      ).rejects.toThrow(/source|receipt/u);
    } else if (direction === "outbound") {
      await expect(
        flow.send("alice", "private coordination", { onPlatformSendDispatch: revokeAndReroute }),
      ).rejects.toThrow(/receipt is no longer current/u);
    } else {
      vi.spyOn(delivered, "status").mockImplementationOnce(async () => {
        await revokeAndReroute();
        return undefined;
      });
      const message = await envelope(peer, keys, id, "private coordination");
      await expect(
        flow.processEntries([
          { seq: 1, peer: "alice", id: message.id, kind: "message", envelope: message, ts: 1 },
        ]),
      ).rejects.toThrow(/receipt is no longer current/u);
    }
    expect(await alternate.get("alice")).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(ingress).not.toHaveBeenCalled();
  },
);
