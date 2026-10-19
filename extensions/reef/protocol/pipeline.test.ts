import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "./audit.js";
import { canonicalBytes } from "./canonical.js";
import { base64, fromBase64url, utf8 } from "./encoding.js";
import { seal, type Envelope } from "./envelope.js";
import type { GuardAdapter, Verdict } from "./guard.js";
import { generateIdentity } from "./identity.js";
import { MemoryAuditStore, MemoryReplayStore } from "./memory-stores.test-support.js";
import {
  composeInbound,
  composeOutbound,
  PipelineError,
  type ReviewApproval,
  type ReviewDecisionState,
  type ReviewGate,
  type ReviewRequest,
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

function audit(): MemoryAuditStore {
  return new MemoryAuditStore(auditKey);
}

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

function structuralGuard(
  pinnedModel: string,
  ...results: unknown[]
): GuardAdapter & { calls: number } {
  return {
    providerId: "structural",
    pinnedModel,
    calls: 0,
    async classify() {
      return (results[this.calls++] ?? results.at(-1)) as Verdict;
    },
  };
}

type OutboundOptions = Parameters<typeof composeOutbound>[0];
type InboundOptions = Parameters<typeof composeInbound>[0];

function identities(defaults: Partial<OutboundOptions> = {}) {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const outboundOptions = (overrides: Partial<OutboundOptions> = {}): OutboundOptions => ({
    id: "01JZ0000000000000000000000",
    from: "alice#1",
    to: "bob#1",
    body: { text: "ordinary text" },
    senderSigningSecretKey: alice.signing.secretKey,
    recipientEncryptionPublicKey: bob.encryption.publicKey,
    guard: mockGuard(allow),
    audit: audit(),
    policyVersion: "v1",
    ...defaults,
    ...overrides,
  });
  const inbound = (
    message: string | Envelope,
    overrides: Partial<InboundOptions> = {},
  ): InboundOptions => ({
    envelope:
      typeof message === "string"
        ? seal({ ...outboundOptions(), body: { text: message }, ts: now })
        : message,
    self: "bob#1",
    recipientEncryptionSecretKey: bob.encryption.secretKey,
    recipientSigningSecretKey: bob.signing.secretKey,
    senderSigningPublicKey: alice.signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
    guard: mockGuard(allow),
    audit: audit(),
    policyVersion: "v1",
    ...overrides,
  });
  return {
    alice,
    bob,
    inbound,
    outbound: (overrides: Partial<OutboundOptions> = {}) =>
      composeOutbound(outboundOptions(overrides)),
  };
}

function reviewVerdict(): Verdict {
  return { ...allow, decision: "review", category: "ambiguous", reason: "Review." };
}

const approvalGate = (approved: boolean) =>
  gateOf(async ({ approvalDigest }) => ({ approved, approvalDigest }));
const recordedGate = (decision: ReviewDecisionState) =>
  gateOf(
    async () => undefined,
    async () => decision,
  );
const rngSpy = () => vi.fn((length: number) => new Uint8Array(length));

function expectAudit(entries: AuditEntry[], types: string[]) {
  expect(entries.map((entry) => entry.event.type)).toEqual(types);
  expect(
    new Set(
      entries.map((entry) => (entry.event.payload as { approvalDigest: string }).approvalDigest),
    ).size,
  ).toBe(1);
}

function gateOf(
  request: (review: ReviewRequest) => Promise<ReviewApproval | undefined>,
  lookup: (approvalDigest: string) => Promise<ReviewDecisionState> = async () => "none",
): ReviewGate {
  return { lookup, request };
}

async function capturePipelineError(promise: Promise<unknown>): Promise<PipelineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected pipeline error");
}

describe("pipeline", () => {
  it.each(["accepted", "failed"] as const)(
    "joins an admitted heartbeat before %s inbound work settles",
    async (outcome) => {
      vi.useFakeTimers();
      const guardEntered = createDeferred<void>();
      const finishGuard = createDeferred<void>();
      const finishRefresh = createDeferred<void>();
      const finalized = createDeferred<void>();
      try {
        const { inbound } = identities();
        const replay = new MemoryReplayStore();
        const refresh = vi
          .spyOn(replay, "refresh")
          .mockImplementationOnce(() => finishRefresh.promise);
        const complete = replay.complete.bind(replay);
        vi.spyOn(replay, "complete").mockImplementation(async (...args) => {
          await complete(...args);
          finalized.resolve();
        });
        const release = replay.release.bind(replay);
        vi.spyOn(replay, "release").mockImplementation(async (...args) => {
          await release(...args);
          finalized.resolve();
        });
        const guard = mockGuard(allow);
        vi.spyOn(guard, "classify").mockImplementation(async () => {
          guardEntered.resolve();
          await finishGuard.promise;
          if (outcome === "failed") {
            throw new Error("synthetic guard interruption");
          }
          return allow;
        });
        let settled = false;
        const pending = composeInbound(
          inbound("ordinary text", { replayStore: replay, guard }),
        ).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        await guardEntered.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(refresh).toHaveBeenCalledTimes(1);
        finishGuard.resolve();
        await finalized.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        finishRefresh.resolve();
        const result = await pending;
        expect(settled).toBe(true);
        if (outcome === "accepted") {
          expect(result).toMatchObject({ value: { disposition: "accepted" } });
        } else {
          expect(result).toHaveProperty("error");
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        finishGuard.resolve();
        finishRefresh.resolve();
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([`Tree: https://github.com/openclaw/openclaw/tree/${githubCommit}/.agents`])(
    "runs an allowed outbound and inbound exchange end to end: %s",
    async (text) => {
      const { inbound: receiveOptions, outbound: send } = identities();
      const outboundAudit = audit();
      const outboundGuard = mockGuard(allow);
      const classifyOutbound = vi.spyOn(outboundGuard, "classify");
      const outbound = await send({
        body: { text },
        ts: now,
        audit: outboundAudit,
        guard: outboundGuard,
      });
      expect(classifyOutbound).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ direction: "outbound", text }),
      );
      const inboundAudit = audit();
      const inboundGuard = mockGuard(allow);
      const classifyInbound = vi.spyOn(inboundGuard, "classify");
      const replayStore = new MemoryReplayStore();
      const options = receiveOptions(outbound.envelope, {
        replayStore,
        guard: inboundGuard,
        audit: inboundAudit,
      });
      const inbound = await composeInbound(options);
      expect(inbound.disposition).toBe("accepted");
      if (inbound.disposition !== "accepted") {
        throw new Error("expected accepted result");
      }
      expect(inbound.body.text).toBe(text);
      expect(classifyInbound).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ direction: "inbound", text }),
      );
      expect(inbound.receipt).toMatchObject({ id: outbound.envelope.id, status: "accepted" });
      const outboundEntries = await outboundAudit.entries();
      const inboundEntries = await inboundAudit.entries();
      expectAudit(outboundEntries, ["proposal", "guard_verdict", "envelope"]);
      expectAudit(inboundEntries, ["guard_verdict", "inbox", "receipt"]);
      const duplicate = await composeInbound({ ...options, now: now + 10 * 60 });
      expect(duplicate).toEqual({
        disposition: "duplicate",
        body: inbound.body,
        receipt: inbound.receipt,
      });
      expect(inboundGuard.calls).toBe(1);
      expect(await inboundAudit.entries()).toHaveLength(inboundEntries.length);
    },
  );

  it("rejects a decrypted free-form thread before guard admission", async () => {
    const { alice, bob, inbound } = identities();
    const guard = mockGuard(allow);
    const envelope = craftEnvelope({ text: "hello", thread: "free-form thread" }, alice, bob);
    await expect(composeInbound(inbound(envelope, { guard }))).rejects.toMatchObject({
      code: "malformed",
    });
    expect(guard.calls).toBe(0);
  });

  it.each([`mailto:review@example.org?next=${githubBlob}`])(
    "stops a deterministic outbound denial before guard and sealing: %s",
    async (text) => {
      const { outbound } = identities();
      const guard = mockGuard(allow);
      const rng = rngSpy();
      await expect(outbound({ body: { text }, guard, rng })).rejects.toMatchObject({
        stage: "deterministic",
      });
      expect(guard.calls).toBe(0);
      expect(rng).not.toHaveBeenCalled();
    },
  );

  it("stops an outbound guard denial before sealing", async () => {
    const { outbound } = identities();
    const deny: Verdict = {
      ...allow,
      decision: "deny",
      category: "confidential",
      reason: "Denied.",
    };
    const rng = rngSpy();
    await expect(
      outbound({ body: { text: githubBlob }, guard: mockGuard(deny), rng }),
    ).rejects.toMatchObject({ stage: "guard", verdict: deny });
    expect(rng).not.toHaveBeenCalled();
  });

  it("centrally rejects invalid verdicts from structural guard adapters", async () => {
    const { outbound } = identities();
    const cases: Array<[string, string, unknown]> = [
      ["wrong model", "mock-2026-07-12", { ...allow, model: "other-2026-07-12" }],
      ["floating model", "mock-latest", { ...allow, model: "mock-latest" }],
      ["wrong policy", "mock-2026-07-12", { ...allow, policyVersion: "v2" }],
      ["unknown decision", "mock-2026-07-12", { ...allow, decision: "maybe" }],
    ];
    for (const [name, pinnedModel, rawVerdict] of cases) {
      const rng = rngSpy();
      await expect(
        outbound({
          id: "01JZ0000000000000000000008",
          body: { text: `case ${name}` },
          guard: structuralGuard(pinnedModel, rawVerdict),
          rng,
        }),
      ).rejects.toMatchObject({
        stage: "guard",
        verdict: { decision: "deny", category: "guard_failure" },
      });
      expect(rng).not.toHaveBeenCalled();
    }
  });

  it("accepts a valid structural adapter and admits the post-review verdict again", async () => {
    const { outbound } = identities({
      id: "01JZ0000000000000000000009",
      body: { text: "structural adapter" },
    });
    await expect(outbound({ guard: structuralGuard(allow.model, allow) })).resolves.toMatchObject({
      verdict: allow,
    });
    const review = reviewVerdict();
    const invalidAfterApproval = { ...allow, model: "wrong-2026-07-12" };
    await expect(
      outbound({
        guard: structuralGuard(allow.model, review, invalidAfterApproval),
        reviewGate: approvalGate(true),
      }),
    ).rejects.toMatchObject({
      stage: "guard",
      verdict: { decision: "deny", category: "guard_failure" },
    });
  });

  it("requires exact full-proposal approval and fresh classification for review", async () => {
    const { outbound } = identities({ body: { text: githubBlob } });
    const review = reviewVerdict();
    await expect(outbound({ guard: mockGuard(review) })).rejects.toMatchObject({ stage: "review" });
    await expect(
      outbound({
        guard: mockGuard(review),
        reviewGate: approvalGate(false),
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "denied", receipt: undefined });
    await expect(
      outbound({
        guard: mockGuard(review),
        reviewGate: gateOf(async () => ({ approved: true, approvalDigest: "wrong" })),
      }),
    ).rejects.toMatchObject({ stage: "review" });
    const guard = mockGuard(review, allow);
    const result = await outbound({ guard, reviewGate: approvalGate(true) });
    expect(result.verdict.decision).toBe("allow");
    expect(guard.calls).toBe(2);
  });

  it("does not reuse an approval across recipients", async () => {
    const review = reviewVerdict();
    const { outbound } = identities({
      id: "01JZ0000000000000000000007",
      from: "sender#1",
      body: { text: "identical body" },
    });
    let vincentDigest = "";
    await expect(
      outbound({
        to: "vincent#1",
        guard: mockGuard(review),
        reviewGate: gateOf(async (request) => {
          vincentDigest = request.approvalDigest;
          expect(request).toMatchObject({
            id: "01JZ0000000000000000000007",
            from: "sender#1",
            to: "vincent#1",
            direction: "outbound",
          });
          expect(request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
          return undefined;
        }),
      }),
    ).rejects.toMatchObject({ stage: "review", reviewOutcome: "pending" });
    await expect(
      outbound({
        to: "alice#1",
        guard: mockGuard(review),
        reviewGate: gateOf(async () => ({ approved: true, approvalDigest: vincentDigest })),
      }),
    ).rejects.toMatchObject({ stage: "review", message: "approval digest mismatch" });
  });

  it("releases a replay claim after transient audit failure and retries successfully", async () => {
    const { inbound } = identities();
    const inboundAudit = audit();
    vi.spyOn(inboundAudit, "appendEvent").mockRejectedValueOnce(
      new Error("transient audit failure"),
    );
    const options = inbound("retry me", { audit: inboundAudit });
    await expect(composeInbound(options)).rejects.toThrow("transient audit failure");
    const retried = await composeInbound(options);
    expect(retried).toMatchObject({ disposition: "accepted", receipt: { status: "accepted" } });
  });

  it("returns an identical cached rejection receipt on guard-deny redelivery", async () => {
    const { inbound } = identities();
    const inboundAudit = audit();
    const deny: Verdict = { ...allow, decision: "deny", category: "injection", reason: "Denied." };
    const guard = mockGuard(deny);
    const options = inbound("classify me", {
      guard,
      audit: inboundAudit,
    });
    const rejection = await capturePipelineError(composeInbound(options));
    expect(rejection.receipt).toMatchObject({ status: "rejected", category: "guard_deny" });
    const entryCount = (await inboundAudit.entries()).length;
    const duplicate = await composeInbound({ ...options, now: now + 1_000 });
    expect(duplicate).toEqual({ disposition: "duplicate", receipt: rejection.receipt });
    expect(duplicate).not.toHaveProperty("body");
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("completes explicit inbound review denial and caches its receipt", async () => {
    const { inbound } = identities();
    const guard = mockGuard(reviewVerdict());
    const inboundAudit = audit();
    const options = inbound("review me", {
      guard,
      audit: inboundAudit,
      reviewGate: approvalGate(false),
    });
    const rejection = await capturePipelineError(composeInbound(options));
    expect(rejection).toMatchObject({
      stage: "review",
      reviewOutcome: "denied",
      receipt: { status: "rejected", category: "review_denied" },
    });
    const entryCount = (await inboundAudit.entries()).length;
    await expect(composeInbound(options)).resolves.toEqual({
      disposition: "duplicate",
      receipt: rejection.receipt,
    });
    expect((await inboundAudit.entries()).length).toBe(entryCount);
    expect(guard.calls).toBe(1);
  });

  it("releases pending inbound review and accepts a later approved retry", async () => {
    const { inbound } = identities();
    const review = reviewVerdict();
    const guard = mockGuard(review, review, allow);
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

  it("holds a pending review on redelivery without re-classifying", async () => {
    const { inbound, outbound } = identities();
    const guard = mockGuard(allow);
    const inboundAudit = audit();
    const options = inbound("parked while pending", {
      guard,
      audit: inboundAudit,
      reviewGate: recordedGate("pending"),
    });
    await expect(composeInbound(options)).rejects.toMatchObject({
      stage: "review",
      reviewOutcome: "pending",
      receipt: undefined,
    });
    // The recorded review owns redelivery: no fresh guard roll may resolve it,
    // and re-attempts must not grow the audit chain.
    expect(guard.calls).toBe(0);
    expect((await inboundAudit.entries()).length).toBe(0);
    await expect(outbound({ guard, reviewGate: recordedGate("pending") })).rejects.toMatchObject({
      stage: "review",
      reviewOutcome: "pending",
    });
    expect(guard.calls).toBe(0);
  });

  it("completes a decided-approved review on redelivery with one classification", async () => {
    const { inbound } = identities();
    const guard = mockGuard(allow);
    const inboundAudit = audit();
    const result = await composeInbound(
      inbound("approved while parked", {
        guard,
        audit: inboundAudit,
        reviewGate: recordedGate({ approved: true }),
      }),
    );
    expect(result.disposition).toBe("accepted");
    expect(guard.calls).toBe(1);
    const entries = await inboundAudit.entries();
    expect(entries.some((entry) => entry.event.type === "review_approval")).toBe(true);
  });

  it("completes a decided-denied review on redelivery without classifying", async () => {
    const { inbound } = identities();
    const guard = mockGuard(allow);
    const rejection = await capturePipelineError(
      composeInbound(
        inbound("denied while parked", {
          guard,
          reviewGate: recordedGate({ approved: false }),
        }),
      ),
    );
    expect(rejection).toMatchObject({
      stage: "review",
      reviewOutcome: "denied",
      receipt: { status: "rejected", category: "review_denied" },
    });
    expect(guard.calls).toBe(0);
  });

  it("parks an inbound guard failure instead of rejecting the peer", async () => {
    const { inbound } = identities();
    const failure: Verdict = {
      ...allow,
      decision: "deny",
      category: "guard_failure",
      reason: "Guard unavailable or invalid.",
    };
    const inboundAudit = audit();
    const failing = inbound("guard outage", {
      guard: mockGuard(failure),
      audit: inboundAudit,
    });
    const parked = await capturePipelineError(composeInbound(failing));
    expect(parked).toMatchObject({
      stage: "guard",
      verdict: { category: "guard_failure" },
      receipt: undefined,
    });
    expect(
      (await inboundAudit.entries()).some((entry) => entry.event.type === "inbox_rejected"),
    ).toBe(false);
    // The replay claim released, so recovery retries once the guard is back.
    const retried = await composeInbound({
      ...failing,
      guard: mockGuard(allow),
      now: now + 60,
    });
    expect(retried.disposition).toBe("accepted");
  });

  it("completes deterministic inbound denial with a signed rejection", async () => {
    const { inbound } = identities();
    const guard = mockGuard(allow);
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
