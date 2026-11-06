import { describe, expect, it } from "vitest";
import fixture from "../fixtures/v1-draft/statements.json" with { type: "json" };
import { bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import { ed25519SignerFromSeed } from "./crypto.js";
import { signDiscoveryRequest, verifyDiscoveryRequest } from "./discovery/request-signing.js";
import { deriveInviteProofKey } from "./invites.js";
import { formatIrohEndpointKey } from "./keys.js";
import {
  buildNodeJoinLink,
  computeNodeRedemptionProof,
  parseNodeJoinLink,
} from "./node-invites.js";

// Fixed cross-language vectors are the independent expected proof bytes, not a round-trip alone.
describe("node join link and proof", () => {
  it("decodes the exact claw pin/routing fields and reproduces the HMAC vector", async () => {
    const link = parseNodeJoinLink(fixture.node_invite.link)!;
    expect(link).toMatchObject({
      claw_id: "0123456789abcdef0123456789abcdef",
      root_fp: fixture.kit.root_fp,
      hostname: "studio-k7x2q.crabd.me",
      relay_url: "https://relay.example.test/",
    });
    expect(bytesToHex(link.secret)).toBe(fixture.node_invite.secret_hex);
    expect(buildNodeJoinLink(link)).toBe(fixture.node_invite.link);
    const proofKey = await deriveInviteProofKey(link.secret);
    expect(bytesToHex(proofKey)).toBe(fixture.node_invite.proof_key_hex);
    expect(
      await computeNodeRedemptionProof(proofKey, {
        claw_id: link.claw_id,
        invite_id: link.invite_id,
        peer_key: `iroh:${fixture.keys.node.ed25519.slice(8)}`,
      }),
    ).toBe(fixture.node_invite.proof);
  });

  it("rejects ambiguous or secret-leaking links", () => {
    const valid = fixture.node_invite.link;
    for (const value of [
      valid + "&c=" + "00".repeat(16),
      valid + "&key=secret",
      valid.replace("join#", "join/path#"),
      valid.replace("join#", "join?i=secret#"),
      valid.replace("//join", "//user@join"),
      valid.replace("openclaw-node:", "https:"),
      valid.replace("https%3A%2F%2Frelay", "http%3A%2F%2Frelay"),
      valid.replace(/&r=[^&]+/, "&r=garbage"),
      valid.replace(/#i=[^&]+/, "#i=" + "00".repeat(16) + ".AA"),
    ]) {
      expect(parseNodeJoinLink(value)).toBeNull();
    }
  });

  it("uses W for bearerless Discovery request signatures bound to exact claw/path/body", async () => {
    const signer = await ed25519SignerFromSeed(hexToBytes(fixture.keys.node.seed_hex));
    const parts = {
      method: "POST",
      path: "/v1/claws/0123456789abcdef0123456789abcdef/mailbox/node",
      body: utf8('{"payload":"node"}'),
      ts: fixture.now,
    };
    const header = await signDiscoveryRequest(parts, signer);
    const checked = await verifyDiscoveryRequest(parts, header, fixture.now);
    expect(checked).toEqual({ ok: true, keyid: fixture.keys.node.ed25519 });
    expect(formatIrohEndpointKey(signer.publicKey)).toBe(fixture.keys.node.iroh);
    expect(
      await verifyDiscoveryRequest({ ...parts, path: parts.path + "/other" }, header, fixture.now),
    ).toMatchObject({ ok: false, code: "unauthorized" });
  });
});
