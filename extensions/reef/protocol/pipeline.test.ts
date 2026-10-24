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

type InboundOptions = Parameters<typeof composeInbound>[0];

function identities() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const inbound = (
    message: string | Envelope,
    overrides: Partial<InboundOptions> = {},
  ): InboundOptions => ({
    envelope:
      typeof message === "string"
        ? seal({
            id: "01JZ0000000000000000000000",
            from: "alice#1",
            to: "bob#1",
            body: { text: message },
            senderSigningSecretKey: alice.signing.secretKey,
            recipientEncryptionPublicKey: bob.encryption.publicKey,
            ts: now,
          })
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
    "accepts and deduplicates an authenticated inbound envelope: %s",
    async (text) => {
      const { inbound: receiveOptions } = identities();
      const inboundAudit = audit();
      const inboundGuard = mockGuard(allow);
      const classifyInbound = vi.spyOn(inboundGuard, "classify");
      const replayStore = new MemoryReplayStore();
      const options = receiveOptions(text, {
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
      expect(inbound.receipt).toMatchObject({ id: options.envelope.id, status: "accepted" });
      const inboundEntries = await inboundAudit.entries();
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
    const { inbound } = identities();
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
