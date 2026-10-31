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
const defaultBody = { text: "hello", replyTo, thread };
const { signing, encryption } = generateIdentity();
const sealOptions = {
  id,
  from: "alice#1",
  to: "bob#1",
  body: defaultBody,
  senderSigningSecretKey: signing.secretKey,
  recipientEncryptionPublicKey: encryption.publicKey,
  ts: now,
};
const envelope = seal(sealOptions);

function opener() {
  const options = {
    envelope,
    self: "bob#1",
    recipientEncryptionSecretKey: encryption.secretKey,
    senderSigningPublicKey: signing.publicKey,
    replayStore: new MemoryReplayStore(),
    now,
  };
  return (changes: Partial<Parameters<typeof openClaimed>[0]> = {}) =>
    openClaimed({ ...options, ...changes });
}

const claimed = (body: Parameters<typeof seal>[0]["body"]) => ({
  claim: "new",
  body,
  envelopeHash: expect.any(String),
});

it("formats, parses, and fingerprints identities stably", () => {
  expect(parseHandleEpoch(formatHandleEpoch("reef-bot", 3))).toEqual({
    handle: "reef-bot",
    keyEpoch: 3,
  });
  expect(fingerprint(signing.publicKey)).toMatch(/^(?:[0-9a-f]{4} ){15}[0-9a-f]{4}$/);
});

describe("device request signatures", () => {
  const request = { method: "POST", path: "/\u2603", ts: 0, bodySha256: "ab".repeat(32) };

  it("matches the protocol signer byte-for-byte across timestamps and rotated keys", () => {
    for (const seed of [0, 255, 0]) {
      const secret = new Uint8Array(32).fill(seed);
      for (const input of [request, { ...request, ts: Number.MAX_SAFE_INTEGER }]) {
        expect(signDeviceRequest(input, base64url(secret))).toBe(
          base64url(ed25519.sign(canonicalBytes(input), secret)),
        );
      }
    }
  });

  it("rejects malformed seeds and changed invalid request fields", () => {
    const secret = base64url(new Uint8Array(32));
    for (const invalidSecret of [
      "!",
      ...[0, 31, 33].map((length) => base64url(new Uint8Array(length))),
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
  it.each([
    ["free-form body identifiers", { text: "hello", replyTo: "prior message" }, MalformedError],
    ["oversized plaintext", { text: "x".repeat(33 * 1024) }, ProtocolError],
  ])("rejects %s when sealing", (_name, body, error) => {
    expect(() => seal({ ...sealOptions, body })).toThrow(error);
  });

  it("verifies every signed field before acting on it", async () => {
    const open = opener();
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

  it.each([
    ["not_pinned", { senderSigningPublicKey: undefined }],
    ["wrong_recipient", { self: "carol#1" }],
    ["expired", { now: now + 40 * 24 * 60 * 60 }],
  ])("rejects %s envelopes", async (code, options) => {
    await expect(opener()(options)).rejects.toMatchObject({ code });
  });

  it("releases failed claims, admits one concurrent open, and binds ids per sender", async () => {
    const open = opener();
    await expect(open({ now: now - 301 })).rejects.toMatchObject({ code: "expired" });
    const results = await Promise.allSettled([open(), open()]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: claimed(defaultBody) },
    ]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "replayed", message: "in flight" },
    });
    const replacement = seal({ ...sealOptions, from: "alice#2", body: { text: "different" } });
    await expect(open({ envelope: replacement })).rejects.toMatchObject({
      code: "replayed",
      name: "ReplayedError",
      message: "replay id binding mismatch",
    });
    const carol = generateIdentity();
    const carolEnvelope = seal({
      ...sealOptions,
      from: "carol#1",
      body: { text: "from carol" },
      senderSigningSecretKey: carol.signing.secretKey,
    });
    await expect(
      open({
        envelope: carolEnvelope,
        senderSigningPublicKey: carol.signing.publicKey,
      }),
    ).resolves.toEqual(claimed({ text: "from carol" }));
  });

  it.each([
    ["oversized ciphertext before decoding", { ct: "!".repeat(44_753) }, TooLargeError],
    ["size boundary at signature validation", { ct: "A".repeat(44_752) }, BadSignatureError],
    ["oversized peer before decoding", { from: "a".repeat(81), ct: "!" }, TooLargeError],
  ])("rejects %s", async (_name, fields, error) => {
    const open = opener();
    await expect(open({ envelope: { ...envelope, ...fields } })).rejects.toBeInstanceOf(error);
  });
});

function flip(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
