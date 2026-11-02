import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/v1-draft/statements.json" with { type: "json" };
import { hexToBytes, utf8 } from "../bytes.js";
import { ed25519SignerFromSeed } from "../crypto.js";
import { formatIrohEndpointKey } from "../keys.js";
import { verifyBindingForPin } from "../statements/pin.js";
import type { SignedStatement } from "../statements/types.js";
import type { StatementVectors } from "../testing/vectors.js";
import {
  checkDescriptorConsistency,
  descriptorEvidence,
  parseClawDescriptor,
  type ClawDescriptor,
} from "./descriptor.js";
import {
  peerKeyProofInput,
  signDiscoveryRequest,
  verifyDiscoveryRequest,
  verifyPeerKeyProof,
} from "./request-signing.js";

const vectors = fixture as unknown as StatementVectors;
const binding = vectors.valid.find((entry) => entry.name === "root signs server binding seq 1")!
  .statement as SignedStatement<"ServerBinding">;
const descriptor: ClawDescriptor = {
  v: 1,
  claw_id: binding.body.claw_id,
  transport: "iroh",
  relay_url: "https://relay.example.test/",
  root_pub: vectors.kit.root_pub,
  rotations: [],
  binding,
  published_at: vectors.now,
};

describe("ClawDescriptor", () => {
  it("parses, passes the Discovery consistency check, and verifies against a client pin", async () => {
    expect(parseClawDescriptor(descriptor)).toEqual({ ok: true, descriptor });
    await expect(
      checkDescriptorConsistency(descriptor, { now: vectors.now }),
    ).resolves.toMatchObject({ ok: true });
    const pin = {
      claw_id: null,
      root_fp: vectors.kit.root_fp as `fp:${string}`,
      root_epoch: 0,
      binding_seq: 0,
    };
    const result = await verifyBindingForPin(descriptorEvidence(descriptor), pin, {
      now: vectors.now,
      host: binding.body.hostname,
    });
    expect(result).toMatchObject({ ok: true, binding: { k_srv: binding.body.k_srv } });
  });

  it("rejects unknown fields, foreign bindings and plain-HTTP remote relays", () => {
    expect(parseClawDescriptor({ ...descriptor, endpointId: "x" })).toMatchObject({ ok: false });
    expect(parseClawDescriptor({ ...descriptor, claw_id: "f".repeat(32) })).toMatchObject({
      ok: false,
      detail: "binding is for another claw",
    });
    expect(
      parseClawDescriptor({ ...descriptor, relay_url: "http://relay.example.test/" }),
    ).toMatchObject({ ok: false });
    expect(
      parseClawDescriptor({ ...descriptor, relay_url: "http://127.0.0.1:47341/" }),
    ).toMatchObject({ ok: true });
  });
});

describe("signed Discovery requests", () => {
  it("verifies the K_gw signature over method, path, timestamp and body", async () => {
    const gateway = await ed25519SignerFromSeed(hexToBytes(vectors.keys.gateway!.seed_hex));
    const parts = {
      method: "PUT",
      path: `/v1/claws/${descriptor.claw_id}/snapshot`,
      body: utf8('{"snapshot":{}}'),
    };
    const header = await signDiscoveryRequest({ ...parts, ts: vectors.now }, gateway);
    await expect(verifyDiscoveryRequest(parts, header, vectors.now + 10)).resolves.toEqual({
      ok: true,
      keyid: vectors.keys.gateway!.ed25519,
    });
    await expect(
      verifyDiscoveryRequest({ ...parts, body: utf8("{}") }, header, vectors.now),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyDiscoveryRequest({ ...parts, path: "/v1/claws" }, header, vectors.now),
    ).resolves.toMatchObject({ ok: false });
    await expect(verifyDiscoveryRequest(parts, header, vectors.now + 301)).resolves.toMatchObject({
      ok: false,
    });
    await expect(verifyDiscoveryRequest(parts, null, vectors.now)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("checks possession of the peer key W when a device binds it", async () => {
    const peer = await ed25519SignerFromSeed(hexToBytes(vectors.keys["peer-1"]!.seed_hex));
    const parts = {
      account_id: "acct_alice",
      device_pub: vectors.keys["device-1"]!.ed25519,
      peer_key: formatIrohEndpointKey(peer.publicKey),
      ts: vectors.now,
    };
    const proof = Buffer.from(await peer.sign(peerKeyProofInput(parts))).toString("base64url");
    await expect(verifyPeerKeyProof(parts, proof)).resolves.toBe(true);
    await expect(verifyPeerKeyProof({ ...parts, account_id: "acct_mallory" }, proof)).resolves.toBe(
      false,
    );
  });
});
