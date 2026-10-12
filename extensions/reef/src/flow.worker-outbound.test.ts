import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity, type Verdict } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
import { isPermanentReefOutboundRejection, prepareReefMessageId, ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
} from "./flow.test-helpers.js";
import { getReefReviewOperationState } from "./state.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

describe("Reef worker outbound composition", () => {
  const cfg = config();
  const peer = generateIdentity();
  const keys = reefKeys();
  const classify = guard(allow);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "sent", status: "queued" }));
  let stores: ReturnType<typeof flowStores>;
  let trusted: ReturnType<typeof openReefTrustStore>;
  let audit: ReturnType<typeof openReefAuditStore>;
  let flow: ReefMessageFlow;

  const makeFlow = (reviews = stores.reviews) =>
    new ReefMessageFlow({
      config: cfg,
      trust: trusted,
      keys,
      transport: new ReefTransportClient(cfg.relayUrl, cfg.handle!, keys, fetcher),
      guard: classify,
      audit,
      replay: new MemoryReplayStore(),
      reviews,
      delivered: stores.delivered,
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    });

  beforeAll(async () => {
    stores = flowStores(undefined, 1);
    trusted = openReefTrustStore(stores.runtime, cfg);
    audit = openReefAuditStore(stores.runtime, new Uint8Array(32).fill(1));
    await trusted.set("alice", peerTrust(peer));
    flow = makeFlow();
    await flow.send("alice", "warm the operation owners");
  });
  beforeEach(async () => {
    await getReefReviewOperationState(stores.reviews)!.store.clear();
    await trusted.set("alice", peerTrust(peer));
    classify.classify.mockReset().mockResolvedValue(allow);
    fetcher.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(resetFlowStoresForTests);

  function recordDispatches() {
    const sends = vi.spyOn(Worker.prototype, "postMessage");
    return () =>
      sends.mock.calls.flatMap(([message]) => {
        if (
          !isRecord(message) ||
          message.type !== "execute" ||
          !(message.input instanceof Uint8Array)
        ) {
          return [];
        }
        const command: unknown = deserialize(Buffer.from(message.input));
        return [isRecord(command) ? command.type : "invalid command"];
      });
  }

  it("persists proposal, verdict, envelope and exact delivery in two worker commands without host SQL", async () => {
    const id = prepareReefMessageId();
    const commands = recordDispatches();
    const hostSql = observeHostDataSql();
    const firstSecond = Math.floor(Date.now() / 1000);
    try {
      expect(await flow.send("alice", "private coordination", { messageId: id })).toBe(id);
      expect(commands()).toEqual(["pluginState.executeOperation", "pluginState.executeOperation"]);
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
    expect(fetcher).toHaveBeenCalledOnce();
    const entries = (await audit.entries()).filter(
      (entry) => isRecord(entry.event.payload) && entry.event.payload.id === id,
    );
    expect(entries.map((entry) => entry.event.type)).toEqual([
      "proposal",
      "guard_verdict",
      "envelope",
    ]);
    for (const entry of entries) {
      expect(entry.event.ts).toBeGreaterThanOrEqual(firstSecond);
      expect(entry.event.ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    }
    const delivery = (await trusted.readOutboundDelivery("alice", id))?.delivery;
    expect(delivery).toMatchObject({
      recipient: { keyEpoch: 1, ed25519PublicKey: peer.signing.publicKey },
    });
    expect(delivery?.bodyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(delivery?.textHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["pending", "denied"] as const)(
    "settles an existing %s review in one command without classifying again",
    async (decision) => {
      const id = prepareReefMessageId();
      classify.classify.mockResolvedValue({ ...allow, decision: "review" });
      await expect(
        flow.send("alice", "private coordination", { messageId: id }),
      ).rejects.toMatchObject({ reviewOutcome: "pending" });
      const [review] = await stores.reviews.list();
      expect(review?.id).toBe(id);
      if (decision === "denied") {
        await stores.reviews.decide(review!.approvalDigest, false);
      }
      classify.classify.mockClear();
      const commands = recordDispatches();
      await expect(
        flow.send("alice", "private coordination", { messageId: id }),
      ).rejects.toMatchObject({ reviewOutcome: decision });
      expect(commands()).toEqual(["pluginState.executeOperation"]);
      expect(classify.classify).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("reclassifies an approved review once and commits its approved send in two commands", async () => {
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await expect(
      flow.send("alice", "private coordination", { messageId: id }),
    ).rejects.toMatchObject({ reviewOutcome: "pending" });
    const [review] = await stores.reviews.list();
    await stores.reviews.decide(review!.approvalDigest, true);
    classify.classify.mockClear();
    const commands = recordDispatches();
    expect(await flow.send("alice", "private coordination", { messageId: id })).toBe(id);
    expect(commands()).toHaveLength(2);
    expect(classify.classify).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      (await audit.entries())
        .filter((entry) => isRecord(entry.event.payload) && entry.event.payload.id === id)
        .map((entry) => entry.event.type),
    ).toEqual([
      "proposal",
      "guard_verdict",
      "proposal",
      "review_approval",
      "guard_verdict",
      "envelope",
    ]);
  });

  it("refuses removal and reapproval with identical keys while classification is pending", async () => {
    classify.classify.mockImplementationOnce(async () => {
      await trusted.remove("alice");
      await trusted.set("alice", peerTrust(peer));
      return allow;
    });
    await expect(flow.send("alice", "private coordination")).rejects.toThrow(
      "changed trust before dispatch",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a committed binding's effect when a sanctioned mutation invalidates its receipt", async () => {
    const result = await flow
      .send("alice", "private coordination", {
        onPlatformSendDispatch: async () => {
          await trusted.remove("alice");
        },
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(isPermanentReefOutboundRejection(result)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the guard audit on a review-capacity refusal without recording delivery", async () => {
    const reviews = stores.reviews;
    await reviews.request({
      id: "occupied",
      from: "bob#1",
      to: "alice#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: "b".repeat(64),
      verdict: { ...allow, decision: "review" },
    });
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    const commands = recordDispatches();
    await expect(
      makeFlow(reviews).send("alice", "private coordination", { messageId: id }),
    ).rejects.toThrow("pending review capacity");
    expect(commands()).toHaveLength(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await audit.entries())
        .filter((entry) => isRecord(entry.event.payload) && entry.event.payload.id === id)
        .map((entry) => entry.event.type),
    ).toEqual(["proposal", "guard_verdict"]);
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
  });

  it("reserves an in-flight message id without another worker request", async () => {
    const started = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<Verdict>();
    classify.classify.mockImplementationOnce(() => {
      started.resolve();
      return verdict.promise;
    });
    const id = prepareReefMessageId();
    const commands = recordDispatches();
    const first = flow.send("alice", "private coordination", { messageId: id });
    try {
      await started.promise;
      await expect(flow.send("alice", "private coordination", { messageId: id })).rejects.toThrow(
        "Duplicate outbound",
      );
      expect(commands()).toHaveLength(1);
    } finally {
      verdict.resolve(allow);
      await first;
    }
    expect(commands()).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
