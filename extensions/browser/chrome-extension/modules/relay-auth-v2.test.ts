import { describe, expect, it } from "vitest";
import { extensionRelayAuthResource, type RelayAuthProofFields } from "./relay-auth-v2-crypto.js";
import { createExtensionRelayAuthClient, parseRelayAuthJson } from "./relay-auth-v2.js";

const fields = {
  keyId: "Yw3NKWbEM2aRElRIu7JbT_",
  instanceId: "EREREREREREREREREREREQ",
  sessionId: "IiIiIiIiIiIiIiIiIiIiIg",
  clientNonce: "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
  serverNonce: "REREREREREREREREREREREREREREREREREREREREREQ",
  issuedAtMs: 1_786_123_456_000,
  expiresAtMs: 1_786_123_466_000,
  role: "extension",
  transport: "websocket",
  method: "GET",
  resource: "/extension?profile=chrome",
  flow: "extension",
} satisfies RelayAuthProofFields;
const { keyId, sessionId, clientNonce, issuedAtMs } = fields;
const serverProof = "ynhaAA_l2HkOGXQ8DvIWfzWwwGjDcV93aumHNe_NM-Q";
const clientProof = "Rl8TStMYlPLxJPDYwSe__mtEjgMf1C4TM-ZN6sUipZ4";
const acceptProof = "1R5MpHs6qnAdc0_X6vKBwj91tlRoWfNuGXaNfSD7VnI";
const forgedProof = "A".repeat(43);
const frame = { type: "auth.challenge", v: 2, ...fields, serverProof };
const challenge = (overrides: Record<string, unknown> = {}) => ({ ...frame, ...overrides });
function ok(proof = acceptProof) {
  return { type: "auth.ok", v: 2, sessionId, acceptProof: proof };
}
async function client(start = true) {
  const auth = await createExtensionRelayAuthClient({
    token: Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(""),
    relayUrl: "ws://127.0.0.1:18797/extension?profile=chrome",
    clientNonce,
    now: () => issuedAtMs + 1,
  });
  if (start) {
    auth.start();
  }
  return auth;
}
describe("Browser Relay Authentication v2", () => {
  it("verifies server and accept proofs around the client response", async () => {
    const auth = await client(false);
    expect(auth.start()).toEqual({ type: "auth.hello", v: 2, keyId, clientNonce });
    const response = { type: "auth.response", v: 2, sessionId, clientProof };
    await expect(auth.acceptChallenge(challenge())).resolves.toEqual(response);
    await expect(auth.acceptOk(ok())).resolves.toBeUndefined();
  });
  it("rejects a bad server proof without producing a client proof", async () => {
    const auth = await client();
    await expect(auth.acceptChallenge(challenge({ serverProof: forgedProof }))).rejects.toThrow(
      "server proof is invalid",
    );
    await expect(auth.acceptChallenge(challenge())).rejects.toThrow("out of sequence");
  });
  it("rejects substituted bindings, invalid lifetimes, and extra challenge fields", async () => {
    for (const mutation of [
      { v: 1 },
      { keyId: "A".repeat(22) },
      { instanceId: "A".repeat(22) },
      { sessionId: "A".repeat(22) },
      { clientNonce: forgedProof },
      { serverNonce: forgedProof },
      { issuedAtMs: issuedAtMs - 1 },
      { expiresAtMs: fields.expiresAtMs - 1 },
      { role: "cdp" },
      { transport: "connection" },
      { method: "POST" },
      { resource: "/other" },
      { flow: "json-list" },
      { issuedAtMs: issuedAtMs - 20_000, expiresAtMs: issuedAtMs - 10_000 },
      { expiresAtMs: issuedAtMs + 10_001 },
      { unexpected: true },
    ]) {
      const auth = await client();
      await expect(auth.acceptChallenge(challenge(mutation))).rejects.toThrow();
    }
  });
  it("rejects bad accept proof and exact-sequence violations", async () => {
    const early = await client(false);
    await expect(early.acceptOk(ok())).rejects.toThrow("out of sequence");
    const auth = await client();
    await auth.acceptChallenge(challenge());
    await expect(auth.acceptOk(ok(forgedProof))).rejects.toThrow("accept proof is invalid");
  });
  it("canonicalizes only the allowed profile query", () => {
    const resource = "/base/browser/extension?profile=work";
    expect(extensionRelayAuthResource(`wss://gateway.example${resource}`)).toBe(resource);
    const url = "ws://127.0.0.1/extension";
    for (const query of ["profile=a&profile=b", "token=nope"]) {
      expect(() => extensionRelayAuthResource(`${url}?${query}`)).toThrow("unsupported query");
    }
  });
  it("rejects duplicate security fields before JSON parsing", () => {
    expect(parseRelayAuthJson('{"type":"auth.ok","v":2,"v":1}')).toBeNull();
    expect(parseRelayAuthJson('{"type":"auth.ok","v":2}')).toEqual({ type: "auth.ok", v: 2 });
  });
  it("rejects oversized authentication frames before JSON parsing", () => {
    expect(parseRelayAuthJson(`{"padding":"${"a".repeat(16 * 1024)}"}`)).toBeNull();
    expect(parseRelayAuthJson(`{"padding":"${"é".repeat(9 * 1024)}"}`)).toBeNull();
  });
});
