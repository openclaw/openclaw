import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes } from "./canonical.js";
import { base64, fromBase64url, utf8 } from "./encoding.js";
import type { Envelope, MessageBody } from "./envelope.js";
import type { GuardAdapter, Verdict } from "./guard.js";
import { generateIdentity } from "./identity.js";
import { MemoryAuditStore, MemoryReplayStore } from "./memory-stores.test-support.js";
import {
  composeInbound,
  PipelineError,
  type ReviewDecisionState,
  type ReviewGate,
} from "./pipeline.js";

const githubCommit = "430f975aacee445525c4663aa88ed1590f2f08b1";
const githubBlob = `https://github.com/openclaw/openclaw/blob/${githubCommit}/.agents/skills/openclaw-pr-maintainer/SKILL.md#review-and-publish`;

const now = 1_752_300_000;
const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const allow: Verdict = {
  decision: "allow",
  category: "safe",
  reason: "Safe.",
  model: "mock-2026-07-12",
  policyVersion: "v1",
};

function mockGuard(...verdicts: Verdict[]): GuardAdapter & { calls: number } {
  return {
    providerId: "mock",
    pinnedModel: "mock-2026-07-12",
    calls: 0,
    async classify() {
      return verdicts[this.calls++] ?? verdicts.at(-1)!;
    },
  };
}

type InboundOptions = Parameters<typeof composeInbound>[0];

function createInbound(guard: GuardAdapter, audit: MemoryAuditStore) {
  const alice = generateIdentity();
  const bob = generateIdentity();
  return (
    message: string | MessageBody,
    overrides: Partial<InboundOptions> = {},
  ): InboundOptions => ({
    envelope: craftEnvelope(typeof message === "string" ? { text: message } : message, alice, bob),
    self: "bob#1",
    recipientEncryptionSecretKey: bob.encryption.secretKey,
    recipientSigningSecretKey: bob.signing.secretKey,
    senderSigningPublicKey: alice.signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
    guard,
    audit,
    policyVersion: "v1",
    ...overrides,
  });
}

const review: Verdict = { ...allow, decision: "review", category: "ambiguous", reason: "Review." };

const approvalGate = (approved: boolean) =>
  gateOf(async ({ approvalDigest }) => ({ approved, approvalDigest }));
const recordedGate = (decision: ReviewDecisionState) =>
  gateOf(
    async () => undefined,
    async () => decision,
  );

function gateOf(
  request: ReviewGate["request"],
  lookup: ReviewGate["lookup"] = async () => "none",
): ReviewGate {
  return { lookup, request };
}

async function capturePipelineError(promise: Promise<unknown>): Promise<PipelineError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.instanceOf(error, PipelineError);
  return error;
}

describe("pipeline", () => {
  let guard: ReturnType<typeof mockGuard>;
  let inboundAudit: MemoryAuditStore;
  let inbound: ReturnType<typeof createInbound>;
  beforeEach(() => {
    guard = mockGuard(allow);
    inboundAudit = new MemoryAuditStore(auditKey);
    inbound = createInbound(guard, inboundAudit);
  });

  it.each(["accepted", "failed"] as const)(
    "joins an admitted heartbeat before %s inbound work settles",
    async (outcome) => {
      vi.useFakeTimers();
      const guardEntered = createDeferred<void>();
      const finishGuard = createDeferred<void>();
      const finishRefresh = createDeferred<void>();
      try {
        const replay = new MemoryReplayStore();
        const refresh = vi
          .spyOn(replay, "refresh")
          .mockImplementationOnce(() => finishRefresh.promise);
        const finalized = vi.spyOn(replay, outcome === "accepted" ? "complete" : "release");
        vi.spyOn(guard, "classify").mockImplementation(async () => {
          guardEntered.resolve();
          await finishGuard.promise;
          if (outcome === "failed") {
            throw new Error("synthetic guard interruption");
          }
          return allow;
        });
        const settled = vi.fn();
        const pending = composeInbound(inbound("ordinary text", { replayStore: replay })).then(
          settled,
          settled,
        );
        await guardEntered.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(refresh).toHaveBeenCalledTimes(1);
        finishGuard.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(finalized).toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        finishRefresh.resolve();
        await pending;
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          outcome === "accepted"
            ? expect.objectContaining({ disposition: "accepted" })
            : expect.any(Error),
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        finishGuard.resolve();
        finishRefresh.resolve();
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    },
  );

  it("accepts and deduplicates an authenticated inbound envelope", async () => {
    const text = `Tree: https://github.com/openclaw/openclaw/tree/${githubCommit}/.agents`;
    const classify = vi.spyOn(guard, "classify");
    const options = inbound(text);
    const result = await composeInbound(options);
    expect(classify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ direction: "inbound", text }),
    );
    expect(result).toMatchObject({
      disposition: "accepted",
      body: { text },
      receipt: { id: options.envelope.id, status: "accepted" },
    });
    const inboundEntries = await inboundAudit.entries();
    expect(inboundEntries.map(({ event }) => event.type)).toEqual([
      "guard_verdict",
      "inbox",
      "receipt",
    ]);
    const digests = inboundEntries.map(
      ({ event }) => (event.payload as { approvalDigest: string }).approvalDigest,
    );
    expect(new Set(digests).size).toBe(1);
    const duplicate = await composeInbound({ ...options, now: now + 10 * 60 });
    expect(duplicate).toEqual({
      disposition: "duplicate",
      body: result.body,
      receipt: result.receipt,
    });
    expect(guard.calls).toBe(1);
    expect(await inboundAudit.entries()).toHaveLength(inboundEntries.length);
  });

  it("rejects a decrypted free-form thread before guard admission", async () => {
    await expect(
      composeInbound(inbound({ text: "hello", thread: "free-form thread" })),
    ).rejects.toMatchObject({
      code: "malformed",
    });
    expect(guard.calls).toBe(0);
  });

  it.each(["guard", "review"] as const)(
    "caches %s rejection without repeating classification or audit",
    async (stage) => {
      guard = mockGuard(stage === "guard" ? { ...allow, decision: "deny" } : review);
      const options = inbound("classify me", { guard, reviewGate: approvalGate(false) });
      const rejection = await capturePipelineError(composeInbound(options));
      expect(rejection).toMatchObject({
        stage,
        reviewOutcome: stage === "review" ? "denied" : undefined,
        receipt: {
          status: "rejected",
          category: stage === "guard" ? "guard_deny" : "review_denied",
        },
      });
      const entryCount = (await inboundAudit.entries()).length;
      const duplicate = await composeInbound({ ...options, now: now + 1_000 });
      expect(duplicate).toEqual({ disposition: "duplicate", receipt: rejection.receipt });
      expect((await inboundAudit.entries()).length).toBe(entryCount);
      expect(guard.calls).toBe(1);
    },
  );

  it("releases pending inbound review and accepts a later approved retry", async () => {
    guard = mockGuard(review, review, allow);
    let decided = false;
    const options = inbound("decide later", {
      guard,
      reviewGate: gateOf(async ({ approvalDigest }) =>
        decided ? { approved: true, approvalDigest } : undefined,
      ),
    });
    await expect(composeInbound(options)).rejects.toMatchObject({
      stage: "review",
      reviewOutcome: "pending",
      receipt: undefined,
    });
    decided = true;
    await expect(composeInbound({ ...options, now: now + 10 * 60 })).resolves.toMatchObject({
      disposition: "accepted",
      body: { text: "decide later" },
    });
    expect(guard.calls).toBe(3);
  });

  it.each(["pending", "approved", "denied"] as const)(
    "honors a recorded %s review on redelivery",
    async (decision) => {
      const recorded = decision === "pending" ? decision : { approved: decision === "approved" };
      const pending = composeInbound(inbound("parked", { reviewGate: recordedGate(recorded) }));
      if (decision === "approved") {
        expect((await pending).disposition).toBe("accepted");
        expect(
          (await inboundAudit.entries()).some((entry) => entry.event.type === "review_approval"),
        ).toBe(true);
      } else {
        expect(await capturePipelineError(pending)).toMatchObject({
          stage: "review",
          reviewOutcome: decision,
          receipt:
            decision === "pending" ? undefined : { status: "rejected", category: "review_denied" },
        });
        if (decision === "pending") {
          expect(await inboundAudit.entries()).toHaveLength(0);
        }
      }
      expect(guard.calls).toBe(decision === "approved" ? 1 : 0);
    },
  );

  it.each(["audit", "guard"] as const)(
    "releases a claim after %s failure for retry",
    async (source) => {
      const options = inbound("retry me");
      if (source === "audit") {
        vi.spyOn(inboundAudit, "appendEvent").mockRejectedValueOnce(
          new Error("transient audit failure"),
        );
        await expect(composeInbound(options)).rejects.toThrow("transient audit failure");
      } else {
        options.guard = mockGuard({ ...allow, decision: "deny", category: "guard_failure" });
        expect(await capturePipelineError(composeInbound(options))).toMatchObject({
          stage: "guard",
          verdict: { category: "guard_failure" },
          receipt: undefined,
        });
        expect(
          (await inboundAudit.entries()).some(({ event }) => event.type === "inbox_rejected"),
        ).toBe(false);
      }
      await expect(
        composeInbound({ ...options, guard: mockGuard(allow), now: now + 60 }),
      ).resolves.toMatchObject({
        disposition: "accepted",
        receipt: { status: "accepted" },
      });
    },
  );

  it("completes deterministic inbound denial with a signed rejection", async () => {
    await expect(
      composeInbound(
        inbound(`${githubBlob} ${["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("")}`, { guard }),
      ),
    ).rejects.toMatchObject({
      stage: "deterministic",
      receipt: { status: "rejected", category: "deterministic_deny" },
    });
    expect(guard.calls).toBe(0);
  });
});

function craftEnvelope(
  body: unknown,
  alice: ReturnType<typeof generateIdentity>,
  bob: ReturnType<typeof generateIdentity>,
): Envelope {
  const ephemeral = x25519.keygen(new Uint8Array(32).fill(7));
  const shared = x25519.getSharedSecret(
    ephemeral.secretKey,
    fromBase64url(bob.encryption.publicKey),
  );
  const key = hkdf(sha256, shared, undefined, utf8("reef-v1"), 32);
  const nonce = new Uint8Array(12).fill(9);
  const unsigned = {
    v: 1 as const,
    id: "01JZ0000000000000000000004",
    from: "alice#1",
    to: "bob#1",
    ts: now,
    epk: base64(ephemeral.publicKey),
    n: base64(nonce),
    ct: base64(gcm(key, nonce).encrypt(canonicalBytes(body))),
  };
  return {
    ...unsigned,
    sig: base64(ed25519.sign(canonicalBytes(unsigned), fromBase64url(alice.signing.secretKey))),
  };
}
