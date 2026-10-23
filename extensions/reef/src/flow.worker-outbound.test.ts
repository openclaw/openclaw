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

  const makeFlow = (reviews = stores.reviews, adapter = classify) =>
    new ReefMessageFlow({
      config: cfg,
      trust: trusted,
      keys,
      transport: new ReefTransportClient(cfg.relayUrl, cfg.handle!, keys, fetcher),
      guard: adapter,
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

  const send = (id: string) => flow.send("alice", "private coordination", { messageId: id });
  async function requestReview() {
    const id = prepareReefMessageId();
    classify.classify.mockResolvedValueOnce({ ...allow, decision: "review" });
    await expect(send(id)).rejects.toMatchObject({ reviewOutcome: "pending" });
    const [review] = await stores.reviews.list();
    expect(review?.id).toBe(id);
    return { id, digest: review!.approvalDigest };
  }
  async function events(id: string) {
    return (await audit.entries())
      .filter((entry) => isRecord(entry.event.payload) && entry.event.payload.id === id)
      .map((entry) => entry.event.type);
  }

  function recordDispatches() {
    const dispatched: unknown[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- call supplies the intercepted worker receiver.
    const nativePost = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      message: unknown,
      transferList,
    ) {
      const commands: unknown[] = [];
      // Decode before the native transfer detaches the sender's command buffer.
      if (isRecord(message) && message.type === "execute" && message.input instanceof Uint8Array) {
        const command: unknown = deserialize(message.input);
        commands.push(isRecord(command) ? command.type : "invalid command");
      }
      nativePost.call(this, message, transferList);
      dispatched.push(...commands);
    });
    return () => dispatched;
  }

  it("persists proposal, verdict, envelope and exact delivery in two worker commands without host SQL", async () => {
    const id = prepareReefMessageId();
    const commands = recordDispatches();
    const hostSql = observeHostDataSql();
    const firstSecond = Math.floor(Date.now() / 1000);
    try {
      expect(await send(id)).toBe(id);
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

  it("refuses deterministic denial before classification or relay dispatch", async () => {
    const id = prepareReefMessageId();
    await expect(
      flow.send(
        "alice",
        "mailto:review@example.org?next=https://github.com/openclaw/openclaw/blob/430f975aacee445525c4663aa88ed1590f2f08b1/README.md",
        {
          messageId: id,
        },
      ),
    ).rejects.toMatchObject({ stage: "deterministic" });
    expect(classify.classify).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
  });

  it.each([
    [
      "content denial",
      allow.model,
      { ...allow, decision: "deny", category: "confidential" },
      "confidential",
    ],
    ["wrong model", allow.model, { ...allow, model: "other-2026-07-12" }, "guard_failure"],
    ["floating model", "mock-latest", { ...allow, model: "mock-latest" }, "guard_failure"],
    ["wrong policy", allow.model, { ...allow, policyVersion: "v2" }, "guard_failure"],
    // The external guard boundary must reject a structurally invalid adapter result.
    ["unknown decision", allow.model, { ...allow, decision: "maybe" }, "guard_failure"],
  ] as const)(
    "refuses %s before recording delivery or dispatching",
    async (_name, model, verdict, category) => {
      const adapter = { ...guard(allow), pinnedModel: model };
      adapter.classify.mockResolvedValue(verdict as Verdict);
      const id = prepareReefMessageId();
      const onPlatformSendDispatch = vi.fn(async () => {});
      await expect(
        makeFlow(stores.reviews, adapter).send("alice", "private coordination", {
          messageId: id,
          onPlatformSendDispatch,
        }),
      ).rejects.toMatchObject({
        stage: "guard",
        verdict: { decision: "deny", category },
        ...(category === "confidential"
          ? { message: expect.stringContaining("Do not retry or rephrase it automatically") }
          : {}),
      });
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    },
  );

  it("does not reuse a durable approval across recipients", async () => {
    await trusted.set("carol", peerTrust(generateIdentity()));
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    const id = prepareReefMessageId();
    await expect(flow.send("alice", "identical body", { messageId: id })).rejects.toMatchObject({
      reviewOutcome: "pending",
    });
    const [review] = await stores.reviews.list();
    expect(review).toMatchObject({ id, from: "bob#1", to: "alice#1", direction: "outbound" });
    await stores.reviews.decide(review!.approvalDigest, true);
    await expect(flow.send("carol", "identical body", { messageId: id })).rejects.toMatchObject({
      reviewOutcome: "pending",
    });
    const reviews = await stores.reviews.list();
    const carolReview = reviews.find((entry) => entry.to === "carol#1");
    expect(carolReview).toMatchObject({ id, direction: "outbound" });
    expect(carolReview?.approvalDigest).not.toBe(review!.approvalDigest);
    expect(await stores.reviews.lookupDecision(carolReview!.approvalDigest)).toBe("pending");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
    expect(await trusted.readOutboundDelivery("carol", id)).toBeUndefined();
  });

  it.each([
    ["wrong model", { ...allow, model: "wrong-2026-07-12" }, "guard_failure"],
    ["content denial", { ...allow, decision: "deny", category: "confidential" }, "confidential"],
  ] as const)("admits the post-approval verdict again: %s", async (_name, verdict, category) => {
    const { id, digest } = await requestReview();
    await stores.reviews.decide(digest, true);
    classify.classify.mockResolvedValue(verdict);
    await expect(send(id)).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await trusted.readOutboundDelivery("alice", id)).toBeUndefined();
  });

  it("settles a denied review in one command without classifying again", async () => {
    const { id, digest } = await requestReview();
    await stores.reviews.decide(digest, false);
    classify.classify.mockClear();
    const commands = recordDispatches();
    await expect(send(id)).rejects.toMatchObject({ reviewOutcome: "denied" });
    expect(commands()).toEqual(["pluginState.executeOperation"]);
    expect(classify.classify).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reclassifies an approved review once and commits its approved send in two commands", async () => {
    const { id, digest } = await requestReview();
    classify.classify.mockResolvedValue({ ...allow, decision: "review" });
    await stores.reviews.decide(digest, true);
    classify.classify.mockClear();
    const commands = recordDispatches();
    expect(await send(id)).toBe(id);
    expect(commands()).toHaveLength(2);
    expect(classify.classify).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await events(id)).toEqual([
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
    expect(await events(id)).toEqual(["proposal", "guard_verdict"]);
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
    const first = send(id);
    try {
      await started.promise;
      await expect(send(id)).rejects.toThrow("Duplicate outbound");
      expect(commands()).toHaveLength(1);
    } finally {
      verdict.resolve(allow);
      await first;
    }
    expect(commands()).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
