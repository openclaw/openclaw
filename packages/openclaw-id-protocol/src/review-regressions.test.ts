// Regressions for the ClawSweeper review of the protocol package (openclaw/openclaw#191469):
// the root-write freeze covers invite registration, untrusted signatures and strings never
// throw, owner-device removal tears down the tunnel key W (not only D), and envelopes carry
// no nested certificate chains.
import { describe, expect, it } from "vitest";
import { registerInvite, submitStatement } from "./authority/apply.js";
import { signDiscoveryRequest, verifyDiscoveryRequest } from "./discovery/request-signing.js";
import { generateInviteSecret, deriveInviteProofKey, inviteSecretHash } from "./invites.js";
import { fingerprint } from "./keys.js";
import { hasValidSignature, signStatement } from "./statements/envelope.js";
import { parseStatement } from "./statements/validate.js";
import { buildWorld, signChange, worldKey, WORLD_NOW } from "./testing/world.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };

// A root-signed InviteCap for the world claw with its proof key.
async function rootInvite(world: Awaited<ReturnType<typeof buildWorld>>) {
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signStatement(
    "InviteCap",
    {
      claw_id: world.state.claw_id,
      invite_id,
      role: "viewer",
      audience: { kind: "email", value: "bob@example.com" },
      label: "Bob",
      created_at: WORLD_NOW - 10,
      expires_at: WORLD_NOW + 86400,
      single_use: true,
      secret_hash: await inviteSecretHash(proofKey),
    },
    world.root,
  );
  return { cap, proofKey };
}

describe("ClawSweeper review regressions", () => {
  it("refuses a root-signed invite over the tunnel while frozen; loopback still works", async () => {
    const world = await buildWorld();
    const frozen = { ...world.state, frozen: true };
    const { cap, proofKey } = await rootInvite(world);
    await expect(registerInvite(frozen, cap, proofKey, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "frozen",
    });
    await expect(
      registerInvite(frozen, cap, proofKey, { channel: "mailbox", now: WORLD_NOW }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      registerInvite(frozen, cap, proofKey, { channel: "local_operator", now: WORLD_NOW }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("answers a noncanonical base64url request signature with unauthorized, not a throw", async () => {
    const world = await buildWorld();
    const parts = { method: "GET", path: "/v1/claws", body: new Uint8Array() };
    const header = await signDiscoveryRequest({ ...parts, ts: WORLD_NOW }, world.device1.signer);
    const noncanonical = header.replace(/sig=[A-Za-z0-9_-]{86}$/, `sig=${"A".repeat(85)}B`);
    await expect(verifyDiscoveryRequest(parts, noncanonical, WORLD_NOW)).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("rejects lone surrogates as malformed before any signature check", async () => {
    const world = await buildWorld();
    const lone = { ...world.cert2, body: { ...world.cert2.body, label: "laptop \ud800" } };
    expect(parseStatement(lone, "OwnerDeviceCert")).toMatchObject({ ok: false, code: "malformed" });
    const paired = { ...world.cert2, body: { ...world.cert2.body, label: "lobster \ud83e\udd9e" } };
    expect(parseStatement(paired, "OwnerDeviceCert")).toMatchObject({ ok: true });
    // An untrusted change whose body was altered after signing to carry a lone surrogate.
    const change = await signChange(world.state, world.device1.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "viewer",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    });
    const altered = {
      ...change,
      body: { ...change.body, target: { ...change.body.target, account_id: "acct_\udc00" } },
    };
    await expect(submitStatement(world.state, altered, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "malformed",
    });
    await expect(hasValidSignature(world.cert2)).resolves.toBe(true);
  });

  it("removing an owner device disconnects and invalidates its tunnel key W, not its signing key D", async () => {
    const world = await buildWorld();
    expect(world.device2.peer.slice(5)).not.toBe(world.device2.pub.slice(8));
    const revocation = await signStatement(
      "Revocation",
      {
        target_fp: await fingerprint(world.device2.pub),
        target_kind: "owner_device",
        reason: "lost",
        root_epoch: 1,
        issued_at: WORLD_NOW - 5,
      },
      world.device1.signer,
    );
    const result = await submitStatement(world.state, revocation, tunnel);
    expect(result.ok && result.events).toEqual([
      { type: "disconnect", peer_keys: [world.device2.peer] },
      { type: "invalidate_tokens", peer_keys: [world.device2.peer] },
      { type: "publish_snapshot" },
    ]);
  });

  it("refuses an envelope that carries a certificate chain, without walking it", async () => {
    const world = await buildWorld();
    // Deeply nested input must be refused at the top level, not recursed into.
    let nested: unknown = [];
    for (let depth = 0; depth < 10_000; depth += 1) {
      nested = [{ ...world.cert1, chain: nested }];
    }
    expect(parseStatement({ ...world.cert2, chain: nested })).toMatchObject({
      ok: false,
      code: "malformed",
    });
    const stranger = await worldKey("stranger");
    expect(stranger.peer.slice(5)).not.toBe(stranger.pub.slice(8));
  });
});
