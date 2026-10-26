import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "./canonical.js";
import { base64url } from "./encoding.js";
import {
  BadSignatureError,
  MalformedError,
  openClaimed,
  ProtocolError,
  seal,
  TooLargeError,
} from "./envelope.js";
import {
  fingerprint,
  formatHandleEpoch,
  generateIdentity,
  parseHandleEpoch,
  signDeviceRequest,
} from "./identity.js";
import { MemoryReplayStore } from "./memory-stores.test-support.js";

const now = 1_752_300_000;
const id = "01JZ0000000000000000000000";
const replyTo = "01JZ0000000000000000000001";
const thread = "01JZ0000000000000000000002";

function fixture(overrides: Partial<Parameters<typeof seal>[0]> = {}) {
  const { signing } = generateIdentity();
  const { encryption } = generateIdentity();
  const sealOptions = {
    id,
    from: "alice#1",
    to: "bob#1",
    body: { text: "hello", replyTo, thread },
    senderSigningSecretKey: signing.secretKey,
    recipientEncryptionPublicKey: encryption.publicKey,
    ts: now,
    ...overrides,
  };
  const envelope = seal(sealOptions);
  const options = {
    envelope,
    self: "bob#1",
    recipientEncryptionSecretKey: encryption.secretKey,
    senderSigningPublicKey: signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
  };
  return {
    sealOptions,
    envelope,
    options,
    open: (changes: Partial<Parameters<typeof openClaimed>[0]> = {}) =>
      openClaimed({ ...options, ...changes }),
    sealBody: (body: Parameters<typeof seal>[0]["body"]) => seal({ ...sealOptions, body }),
  };
}

const claimed = (body: Parameters<typeof seal>[0]["body"]) => ({
  claim: "new",
  body,
  envelopeHash: expect.any(String),
});

it("formats, parses, and fingerprints identities stably", () => {
  const identity = generateIdentity();
  expect(parseHandleEpoch(formatHandleEpoch("reef-bot", 3))).toEqual({
    handle: "reef-bot",
    keyEpoch: 3,
  });
  expect(fingerprint(identity.signing.publicKey)).toMatch(/^(?:[0-9a-f]{4} ){15}[0-9a-f]{4}$/);
});

describe("device request signatures", () => {
  const request = { method: "GET", path: "/v1/mail/ws", ts: now, bodySha256: "0".repeat(64) };

  it("matches the protocol signer byte-for-byte across messages and rotated device keys", () => {
    const seeds = [0, 1, 127, 255].map((value) => new Uint8Array(32).fill(value));
    for (const secret of [...seeds, seeds[0]!]) {
      for (const input of [
        request,
        { ...request, method: "POST", path: "/v1/mail/send", ts: 0 },
        { ...request, path: "/v1/mail/\u2603?cursor=1", ts: Number.MAX_SAFE_INTEGER },
        { ...request, method: "DELETE", bodySha256: "abcdef0123456789".repeat(4) },
      ]) {
        expect(signDeviceRequest(input, base64url(secret))).toBe(
          base64url(ed25519.sign(canonicalBytes(input), secret)),
        );
      }
    }
  });

  it("rejects malformed seeds and changed invalid request fields", () => {
    const secret = base64url(new Uint8Array(32));
    for (const invalidSecret of [
      "",
      "!",
      `${secret}=`,
      "AB",
      base64url(new Uint8Array(31)),
      base64url(new Uint8Array(33)),
    ]) {
      expect(() => signDeviceRequest(request, invalidSecret)).toThrow();
    }
    for (const input of [
      { ...request, method: "get" },
      { ...request, path: "v1/mail/ws" },
      { ...request, ts: -1 },
      { ...request, ts: 0.5 },
      { ...request, ts: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, bodySha256: "A".repeat(64) },
    ]) {
      expect(() => signDeviceRequest(input, secret)).toThrow(
        "invalid device request signature input",
      );
    }
  });
});

describe("envelope", () => {
  it("releases a failed envelope claim for retry", async () => {
    const { open } = fixture();
    await expect(open({ now: now - 301 })).rejects.toMatchObject({ code: "expired" });
    await expect(open()).resolves.toEqual(claimed({ text: "hello", replyTo, thread }));
  });

  it("rejects free-form body identifiers when sealing", () => {
    const { sealBody } = fixture();
    expect(() => sealBody({ text: "hello", replyTo: "prior message" })).toThrow(MalformedError);
  });

  it("verifies every signed field before acting on it", async () => {
    const { open, envelope } = fixture();
    const mutations: Array<Parameters<typeof openClaimed>[0]["envelope"]> = [
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
      await expect(open({ envelope: mutated })).rejects.toMatchObject({ code: "bad_signature" });
    }
  });

  it("rejects an unpinned sender", async () => {
    const { senderSigningPublicKey: _senderKey, ...options } = fixture().options;
    await expect(openClaimed(options)).rejects.toMatchObject({ code: "not_pinned" });
  });

  it("rejects the wrong recipient", async () => {
    const { open } = fixture();
    await expect(open({ self: "carol#1" })).rejects.toMatchObject({ code: "wrong_recipient" });
  });

  it("rejects envelopes older than relay retention", async () => {
    const { open } = fixture({ body: { text: "ancient" }, ts: now - 40 * 24 * 60 * 60 });
    await expect(open()).rejects.toMatchObject({ code: "expired" });
  });

  it("permanently binds an id to the first verified envelope hash", async () => {
    const { open, sealOptions } = fixture();
    await open();
    const replacement = seal({ ...sealOptions, from: "alice#2", body: { text: "different" } });
    await expect(open({ envelope: replacement })).rejects.toMatchObject({
      code: "replayed",
      name: "ReplayedError",
      message: "replay id binding mismatch",
    });
  });

  it("namespaces identical envelope ids by authenticated sender handle", async () => {
    const { open, sealOptions } = fixture({ body: { text: "from alice" } });
    const carol = generateIdentity();
    const carolEnvelope = seal({
      ...sealOptions,
      from: "carol#1",
      body: { text: "from carol" },
      senderSigningSecretKey: carol.signing.secretKey,
    });
    await expect(open()).resolves.toEqual(claimed({ text: "from alice" }));
    await expect(
      open({
        envelope: carolEnvelope,
        senderSigningPublicKey: carol.signing.publicKey,
      }),
    ).resolves.toEqual(claimed({ text: "from carol" }));
  });

  it("atomically admits exactly one concurrent open", async () => {
    const { open } = fixture();
    const results = await Promise.allSettled([open(), open()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "replayed", message: "in flight" },
    });
  });

  it("enforces the plaintext cap", () => {
    const { sealBody } = fixture();
    expect(() => sealBody({ text: "x".repeat(33 * 1024) })).toThrow(ProtocolError);
  });

  it.each([
    ["oversized ciphertext before decoding", { ct: "!".repeat(44_753) }, TooLargeError],
    ["size boundary at signature validation", { ct: "A".repeat(44_752) }, BadSignatureError],
    [
      "huge peer before decoding ciphertext",
      { from: "a".repeat(10 * 1024 * 1024), ct: "!" },
      TooLargeError,
    ],
  ])("rejects %s", async (_name, fields, error) => {
    const { open, envelope } = fixture();
    await expect(open({ envelope: { ...envelope, ...fields } })).rejects.toBeInstanceOf(error);
  });
});

function flip(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
