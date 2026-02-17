import { describe, it, expect } from "vitest";
import type { DID } from "../types.js";
import {
  generateDID,
  didFromPublicKey,
  publicKeyFromDID,
  resolveDID,
  signWithDID,
  verifyWithDID,
  isValidDIDKey,
  toHex,
  fromHex,
} from "./did.js";

describe("DID Generation", () => {
  it("generates a valid did:key", () => {
    const identity = generateDID();
    expect(identity.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(identity.publicKey).toHaveLength(32);
    expect(identity.privateKey).toHaveLength(32);
  });

  it("generates unique DIDs each time", () => {
    const a = generateDID();
    const b = generateDID();
    expect(a.did).not.toBe(b.did);
    expect(toHex(a.publicKey)).not.toBe(toHex(b.publicKey));
  });

  it("generates DIDs starting with z6Mk (Ed25519 multicodec)", () => {
    // Ed25519 multicodec (0xed01) in base58btc always starts with z6Mk
    const identity = generateDID();
    const multibase = identity.did.slice("did:key:".length);
    expect(multibase).toMatch(/^z6Mk/);
  });
});

describe("DID Encoding", () => {
  it("encodes a known public key to a deterministic did:key", () => {
    const pubkey = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa3f4a18446b0b8d183f8e3");
    const did = didFromPublicKey(pubkey);
    expect(did).toMatch(/^did:key:z6Mk/);

    // Same key always produces same DID
    const did2 = didFromPublicKey(pubkey);
    expect(did).toBe(did2);
  });

  it("rejects invalid key lengths", () => {
    expect(() => didFromPublicKey(new Uint8Array(16))).toThrow("Invalid Ed25519 public key length");
    expect(() => didFromPublicKey(new Uint8Array(64))).toThrow("Invalid Ed25519 public key length");
    expect(() => didFromPublicKey(new Uint8Array(0))).toThrow("Invalid Ed25519 public key length");
  });
});

describe("DID Resolution", () => {
  it("round-trips: generate → encode → resolve → extract key", () => {
    const identity = generateDID();
    const extracted = publicKeyFromDID(identity.did);
    expect(toHex(extracted)).toBe(toHex(identity.publicKey));
  });

  it("resolves to a valid DID Document", () => {
    const identity = generateDID();
    const doc = resolveDID(identity.did);

    expect(doc["@context"]).toBe("https://www.w3.org/ns/did/v1");
    expect(doc.id).toBe(identity.did);
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].type).toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].controller).toBe(identity.did);
    expect(doc.authentication).toHaveLength(1);
    expect(doc.assertionMethod).toHaveLength(1);
  });

  it("DID Document key ID uses fragment syntax", () => {
    const identity = generateDID();
    const doc = resolveDID(identity.did);

    const multibase = identity.did.slice("did:key:".length);
    const expectedKeyId = `${identity.did}#${multibase}`;

    expect(doc.verificationMethod[0].id).toBe(expectedKeyId);
    expect(doc.authentication[0]).toBe(expectedKeyId);
    expect(doc.assertionMethod[0]).toBe(expectedKeyId);
  });

  it("rejects non-did:key identifiers", () => {
    expect(() => publicKeyFromDID("did:web:example.com" as DID)).toThrow(
      "Not a did:key identifier",
    );
  });

  it("rejects malformed did:key values", () => {
    expect(() => publicKeyFromDID("did:key:notvalidbase58!!!" as DID)).toThrow();
  });
});

describe("Signing and Verification", () => {
  it("signs and verifies data", () => {
    const identity = generateDID();
    const data = new TextEncoder().encode("Hello, governed world!");

    const proof = signWithDID(data, identity.privateKey, identity.did);

    expect(proof.type).toBe("Ed25519Signature2020");
    expect(proof.proofValue).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(proof.created).toBeTruthy();

    const valid = verifyWithDID(data, proof, identity.did);
    expect(valid).toBe(true);
  });

  it("rejects tampered data", () => {
    const identity = generateDID();
    const data = new TextEncoder().encode("Original message");
    const proof = signWithDID(data, identity.privateKey, identity.did);

    const tampered = new TextEncoder().encode("Tampered message");
    const valid = verifyWithDID(tampered, proof, identity.did);
    expect(valid).toBe(false);
  });

  it("rejects wrong signer", () => {
    const alice = generateDID();
    const bob = generateDID();
    const data = new TextEncoder().encode("Signed by Alice");

    const proof = signWithDID(data, alice.privateKey, alice.did);

    // Verify against Bob's DID — should fail
    const valid = verifyWithDID(data, proof, bob.did);
    expect(valid).toBe(false);
  });

  it("rejects corrupted proof values", () => {
    const identity = generateDID();
    const data = new TextEncoder().encode("Test data");
    const proof = signWithDID(data, identity.privateKey, identity.did);

    // Corrupt the proof
    const corrupted = { ...proof, proofValue: "zinvalidproofvalue" };
    const valid = verifyWithDID(data, corrupted, identity.did);
    expect(valid).toBe(false);
  });

  it("rejects proof with wrong prefix", () => {
    const identity = generateDID();
    const data = new TextEncoder().encode("Test");
    const proof = signWithDID(data, identity.privateKey, identity.did);

    const bad = { ...proof, proofValue: "notmultibase" };
    expect(verifyWithDID(data, bad, identity.did)).toBe(false);
  });
});

describe("Validation", () => {
  it("validates correct did:key identifiers", () => {
    const identity = generateDID();
    expect(isValidDIDKey(identity.did)).toBe(true);
  });

  it("rejects non-did:key strings", () => {
    expect(isValidDIDKey("did:web:example.com")).toBe(false);
    expect(isValidDIDKey("not-a-did")).toBe(false);
    expect(isValidDIDKey("")).toBe(false);
    expect(isValidDIDKey("did:key:")).toBe(false);
  });
});

describe("Hex Utilities", () => {
  it("round-trips hex encoding", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const hex = toHex(original);
    expect(hex).toBe("00017f80ff");
    const decoded = fromHex(hex);
    expect(toHex(decoded)).toBe(hex);
  });

  it("rejects odd-length hex strings", () => {
    expect(() => fromHex("abc")).toThrow("odd length");
  });
});

describe("Cross-Identity Scenarios", () => {
  it("agent signs a ledger entry, human verifies", () => {
    const agent = generateDID();
    const _human = generateDID();

    // Agent signs a ledger entry
    const entry = JSON.stringify({
      action: "agent.message",
      actorDid: agent.did,
      timestamp: new Date().toISOString(),
      payload: { content: "Task completed" },
    });
    const entryBytes = new TextEncoder().encode(entry);
    const proof = signWithDID(entryBytes, agent.privateKey, agent.did);

    // Human (or any verifier) resolves agent's DID and verifies
    const doc = resolveDID(agent.did);
    expect(doc.id).toBe(agent.did);

    const valid = verifyWithDID(entryBytes, proof, agent.did);
    expect(valid).toBe(true);
  });

  it("permission contract: human signs, agent verifies", () => {
    const human = generateDID();
    const agent = generateDID();

    // Human creates and signs a permission contract
    const contract = JSON.stringify({
      type: ["VerifiableCredential", "PermissionContract"],
      issuer: human.did,
      subject: agent.did,
      scope: { actions: ["sessions_send"], targetAgents: [agent.did] },
      expiresAt: "2026-12-31T23:59:59Z",
    });
    const contractBytes = new TextEncoder().encode(contract);
    const proof = signWithDID(contractBytes, human.privateKey, human.did);

    // Agent receives the contract and verifies the human's signature
    const valid = verifyWithDID(contractBytes, proof, human.did);
    expect(valid).toBe(true);
  });
});
