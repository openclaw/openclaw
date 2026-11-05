import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REEF_ENVELOPE_MAX_AGE_SECONDS, type Verdict } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import {
  allow,
  createFlow,
  envelope,
  inbox,
  resetFlowStoresForTests,
} from "./flow.test-helpers.js";
import { setReefRuntime } from "./runtime.js";
import { ReefInboxEntryParkedError } from "./transport.js";

beforeEach(async () => {
  await resetFlowStoresForTests();
  setReefRuntime(createPluginRuntimeMock());
});
afterEach(() => resetFlowStoresForTests());

describe("ReefMessageFlow pending review receipts", () => {
  it.each([true, false])(
    "skips pending replay writes until owner approval=%s",
    async (approved) => {
      const replay = new MemoryReplayStore();
      const claim = vi.spyOn(replay, "claim");
      const release = vi.spyOn(replay, "release");
      const review: Verdict = { ...allow, decision: "review", category: "ambiguous" };
      const { peerKeys, keys, stores, onIngress, relay, flow } = await createFlow({
        verdicts: [review, allow],
        replay,
      });
      const entry = inbox(
        await envelope(peerKeys, keys, "01JZ0000000000000000000106", "review me"),
      );
      // The first retry observes the newly created pending review. Later polls
      // carry that receipt until the review owner invalidates it.
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(flow.processEntries([entry])).rejects.toBeInstanceOf(
          ReefInboxEntryParkedError,
        );
      }
      expect(claim).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
      expect(onIngress).not.toHaveBeenCalled();
      expect(relay.acknowledge).not.toHaveBeenCalled();

      const [pending] = await stores.reviews.list();
      await stores.reviews.decide(pending!.approvalDigest, approved);
      await flow.processEntries([entry]);
      expect(claim).toHaveBeenCalledTimes(3);
      expect(onIngress).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(relay.acknowledge.mock.calls[0]![2].status).toBe(approved ? "accepted" : "rejected");
    },
  );

  it.each(["envelope", "policy", "expiry"] as const)(
    "rechecks a parked review after %s changes",
    async (change) => {
      const replay = new MemoryReplayStore();
      const claim = vi.spyOn(replay, "claim");
      const review: Verdict = { ...allow, decision: "review", category: "ambiguous" };
      const { peerKeys, keys, flow, classifier, onIngress } = await createFlow({
        verdicts: [review],
        replay,
      });
      const entry = inbox(
        await envelope(peerKeys, keys, "01JZ0000000000000000000107", "review me"),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(flow.processEntries([entry])).rejects.toBeInstanceOf(
          ReefInboxEntryParkedError,
        );
      }
      expect(claim).toHaveBeenCalledTimes(2);
      if (change === "envelope") {
        entry.envelope = await envelope(peerKeys, keys, entry.id, "changed body");
        await expect(flow.processEntries([entry])).rejects.toThrow("replay id binding mismatch");
      } else if (change === "policy") {
        flow.options.config.guard!.policyVersion = "changed-policy";
        classifier.classify.mockResolvedValue({ ...review, policyVersion: "changed-policy" });
        await expect(flow.processEntries([entry])).rejects.toBeInstanceOf(
          ReefInboxEntryParkedError,
        );
      } else {
        vi.spyOn(Date, "now").mockReturnValue(
          (entry.envelope!.ts + REEF_ENVELOPE_MAX_AGE_SECONDS + 1) * 1000,
        );
        await expect(flow.processEntries([entry])).rejects.toThrow("expired");
      }
      expect(claim).toHaveBeenCalledTimes(3);
      expect(onIngress).not.toHaveBeenCalled();
    },
  );
});
