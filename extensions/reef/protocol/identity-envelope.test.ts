import { describe, expect, it } from "vitest";
import {
  BadSignatureError,
  MalformedError,
  open,
  ProtocolError,
  seal,
  TooLargeError,
} from "./envelope.js";
import { fingerprint, formatHandleEpoch, generateIdentity, parseHandleEpoch } from "./identity.js";
import { MemoryReplayStore } from "./memory-stores.test-support.js";

const now = 1_752_300_000;
const id = "01JZ0000000000000000000000";
const replyTo = "01JZ0000000000000000000001";
const thread = "01JZ0000000000000000000002";

function fixture(overrides: Partial<Parameters<typeof seal>[0]> = {}) {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const sealOptions = {
    id,
    from: "alice#1",
    to: "bob#1",
    body: { text: "hello", replyTo, thread },
    senderSigningSecretKey: alice.signing.secretKey,
    recipientEncryptionPublicKey: bob.encryption.publicKey,
    ts: now,
    ...overrides,
  };
  const envelope = seal(sealOptions);
  const options = {
    envelope,
    self: "bob#1",
    recipientEncryptionSecretKey: bob.encryption.secretKey,
    senderSigningPublicKey: alice.signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
  };
  return { sealOptions, envelope, options };
}

describe("identity", () => {
  it("formats, parses, and fingerprints identities stably", () => {
    const identity = generateIdentity();
    expect(parseHandleEpoch(formatHandleEpoch("reef-bot", 3))).toEqual({
      handle: "reef-bot",
      keyEpoch: 3,
    });
    expect(fingerprint(identity.signing.publicKey)).toMatch(/^(?:[0-9a-f]{4} ){15}[0-9a-f]{4}$/);
  });
});

describe("envelope", () => {
  it("consumes a standalone envelope after one successful open", async () => {
    const { options } = fixture();
    await expect(open(options)).resolves.toEqual({ text: "hello", replyTo, thread });
    await expect(open(options)).rejects.toMatchObject({
      code: "replayed",
      message: "duplicate envelope",
    });
    await expect(options.replayStore.completed("alice", id)).resolves.toBeUndefined();
  });

  it("releases a failed standalone open for retry", async () => {
    const { options } = fixture();
    await expect(open({ ...options, now: now - 301 })).rejects.toMatchObject({ code: "expired" });
    await expect(open({ ...options, now })).resolves.toEqual({ text: "hello", replyTo, thread });
  });

  it("rejects free-form body identifiers when sealing", () => {
    const { sealOptions } = fixture();
    expect(() =>
      seal({
        ...sealOptions,
        body: { text: "hello", replyTo: "prior message" },
      }),
    ).toThrow(MalformedError);
  });

  it("verifies every signed field before acting on it", async () => {
    const { options, envelope } = fixture();
    const mutations: Array<Parameters<typeof open>[0]["envelope"]> = [
      { ...envelope, v: 2 },
      { ...envelope, id: `${envelope.id.slice(0, -1)}1` },
      { ...envelope, from: "mallory#1" },
      { ...envelope, to: "mallory#1" },
      { ...envelope, ts: envelope.ts + 1 },
      { ...envelope, epk: flip(envelope.epk) },
      { ...envelope, n: flip(envelope.n) },
      { ...envelope, ct: flip(envelope.ct) },
      { ...envelope, sig: flip(envelope.sig) },
    ];
    for (const mutated of mutations) {
      await expect(open({ ...options, envelope: mutated })).rejects.toMatchObject({
        code: "bad_signature",
      });
    }
  });

  it("rejects an unpinned sender", async () => {
    const { senderSigningPublicKey: _senderKey, ...options } = fixture().options;
    await expect(open(options)).rejects.toMatchObject({ code: "not_pinned" });
  });

  it("rejects the wrong recipient", async () => {
    const { options } = fixture();
    await expect(open({ ...options, self: "carol#1" })).rejects.toMatchObject({
      code: "wrong_recipient",
    });
  });

  it("accepts store-and-forward delivery ten minutes later", async () => {
    const { options } = fixture({
      body: { text: "delayed" },
      ts: now - 10 * 60,
    });
    await expect(open(options)).resolves.toEqual({ text: "delayed" });
  });

  it("rejects envelopes older than relay retention", async () => {
    const { options } = fixture({
      body: { text: "ancient" },
      ts: now - 40 * 24 * 60 * 60,
    });
    await expect(open(options)).rejects.toMatchObject({ code: "expired" });
  });

  it("permanently binds an id to the first verified envelope hash", async () => {
    const { options, sealOptions } = fixture();
    await open(options);
    const replacement = seal({
      ...sealOptions,
      from: "alice#2",
      body: { text: "different" },
    });
    await expect(open({ ...options, envelope: replacement })).rejects.toMatchObject({
      code: "replayed",
      message: "replay id binding mismatch",
    });
  });

  it("namespaces identical envelope ids by authenticated sender handle", async () => {
    const { options, sealOptions } = fixture({ body: { text: "from alice" } });
    const carol = generateIdentity();
    const carolEnvelope = seal({
      ...sealOptions,
      from: "carol#1",
      body: { text: "from carol" },
      senderSigningSecretKey: carol.signing.secretKey,
    });
    await expect(open(options)).resolves.toEqual({ text: "from alice" });
    await expect(
      open({
        ...options,
        envelope: carolEnvelope,
        senderSigningPublicKey: carol.signing.publicKey,
      }),
    ).resolves.toEqual({ text: "from carol" });
  });

  it("atomically admits exactly one concurrent open", async () => {
    const { options } = fixture();
    const results = await Promise.allSettled([open(options), open(options)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "replayed", message: "in flight" },
    });
  });

  it("enforces the plaintext cap", () => {
    const { sealOptions } = fixture();
    expect(() =>
      seal({
        ...sealOptions,
        body: { text: "x".repeat(33 * 1024) },
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects oversized ciphertext before base64 decoding", async () => {
    const { options, envelope } = fixture();
    const oversized = { ...envelope, ct: "!".repeat(44_753) };
    await expect(open({ ...options, envelope: oversized })).rejects.toBeInstanceOf(TooLargeError);
  });

  it("accepts the ciphertext size boundary for signature validation", async () => {
    const { options, envelope } = fixture();
    const boundary = { ...envelope, ct: "A".repeat(44_752) };
    await expect(open({ ...options, envelope: boundary })).rejects.toBeInstanceOf(
      BadSignatureError,
    );
  });

  it("rejects huge peer fields before decoding ciphertext", async () => {
    const { options, envelope } = fixture();
    const oversized = { ...envelope, from: "a".repeat(10 * 1024 * 1024), ct: "!" };
    await expect(open({ ...options, envelope: oversized })).rejects.toBeInstanceOf(TooLargeError);
  });
});

function flip(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
