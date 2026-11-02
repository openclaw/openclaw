// Spec section 11 acceptance tests 1, 2, 6, 7 and 10 (client and transport side).
import { describe, expect, it } from "vitest";
import { repinRoot, submitRedemption } from "../authority/apply.js";
import { linkClaw } from "../authority/state.js";
import { descriptorEvidence, type ClawDescriptor } from "../discovery/descriptor.js";
import {
  generateEphemeralKey,
  openHandoff,
  sasCode,
  sasCommitment,
  sasSharedSecret,
  sasTranscript,
  sealHandoff,
  verifySasCommitment,
  type SasStart,
} from "../enrollment/sas.js";
import { buildInviteLink, generateInviteSecret } from "../invites.js";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin, type ClawPin } from "../statements/pin.js";
import { acceptanceTitle } from "../testing/acceptance.js";
import { buildWorld, WORLD_HOST, WORLD_NOW } from "../testing/world.js";
import { inviteFixture } from "./invite-fixture.js";

async function setup() {
  const world = await buildWorld();
  const descriptor: ClawDescriptor = {
    v: 1,
    claw_id: world.state.claw_id,
    transport: "iroh",
    relay_url: "https://relay.example.test/",
    root_pub: world.rootPub,
    rotations: [],
    binding: world.binding,
    published_at: WORLD_NOW,
  };
  const pin: ClawPin = {
    claw_id: world.state.claw_id,
    root_fp: await fingerprint(world.rootPub),
    root_epoch: 1,
    binding_seq: 1,
  };
  return { world, descriptor, pin };
}

const context = { now: WORLD_NOW, host: WORLD_HOST };

describe(acceptanceTitle(1), () => {
  it("dials only the K_srv of a binding that chains to the pinned root", async () => {
    const { world, descriptor, pin } = await setup();
    const result = await verifyBindingForPin(descriptorEvidence(descriptor), pin, context);
    expect(result).toMatchObject({ ok: true, binding: { k_srv: world.server.peer } });
  });

  it("refuses a binding re-signed by Discovery for its own server key", async () => {
    const { world, descriptor, pin } = await setup();
    const forged = await signStatement(
      "ServerBinding",
      { ...world.binding.body, k_srv: world.mallory.peer },
      world.mallory.signer,
    );
    const result = await verifyBindingForPin(
      descriptorEvidence({ ...descriptor, binding: forged }),
      pin,
      context,
    );
    expect(result).toMatchObject({ ok: false, code: "wrong_signer" });
  });

  it("refuses a substituted root key and a genuine binding for another host or claw", async () => {
    const { world, descriptor, pin } = await setup();
    const forged = await signStatement(
      "ServerBinding",
      { ...world.binding.body, k_srv: world.mallory.peer },
      world.mallory.signer,
    );
    const swappedRoot = { ...descriptor, root_pub: world.mallory.pub, binding: forged };
    await expect(
      verifyBindingForPin(descriptorEvidence(swappedRoot), pin, context),
    ).resolves.toMatchObject({ code: "root_mismatch" });
    await expect(
      verifyBindingForPin(descriptorEvidence(descriptor), pin, {
        ...context,
        host: "other-claw.crabd.me",
      }),
    ).resolves.toMatchObject({
      code: "host_mismatch",
    });
    const otherClaw = await signStatement(
      "ServerBinding",
      { ...world.binding.body, claw_id: "e".repeat(32), binding_seq: 5 },
      world.root,
    );
    await expect(
      verifyBindingForPin(descriptorEvidence({ ...descriptor, binding: otherClaw }), pin, context),
    ).resolves.toMatchObject({
      code: "wrong_claw",
    });
  });
});

describe(acceptanceTitle(2), () => {
  const start: SasStart = {
    request_id: "5a".repeat(16),
    claw_id: "c1a0".repeat(8),
    device_pub: `ed25519:${"11".repeat(32)}`,
    peer_key: `iroh:${"22".repeat(32)}`,
    label: "new phone",
  };

  it("a relay that substitutes ephemeral keys produces different codes and cannot open the handoff", async () => {
    const [n, e, toE, toN] = await Promise.all(
      [1, 2, 3, 4].map((fill) => generateEphemeralKey(new Uint8Array(32).fill(fill))),
    );
    // N -> relay: commit(eph_N). Relay -> E: its own commitment to toE (fixed before it sees eph_E).
    const commitN = await sasCommitment(n!.publicKey, start);
    const commitToE = await sasCommitment(toE!.publicKey, start);
    // E's view: peer key toE; N's view: peer key toN (fixed before the relay sees eph_N).
    const transcriptE = await sasTranscript({
      start,
      commit: commitToE,
      ephemeralPublicE: e!.publicKey,
      ephemeralPublicN: toE!.publicKey,
      devicePubE: "ed25519:e",
    });
    const transcriptN = await sasTranscript({
      start,
      commit: commitN,
      ephemeralPublicE: toN!.publicKey,
      ephemeralPublicN: n!.publicKey,
      devicePubE: "ed25519:e",
    });
    const ssE = await sasSharedSecret(e!, toE!.publicKey);
    const ssN = await sasSharedSecret(n!, toN!.publicKey);
    expect(await sasCode(ssE, transcriptE)).not.toBe(await sasCode(ssN, transcriptN));
    const sealed = await sealHandoff(ssE, transcriptE, { root_pub: "ed25519:r" });
    await expect(openHandoff(ssN, transcriptN, sealed)).resolves.toBeNull();
  });

  it("E rejects a revealed key that does not match the commitment (no grinding after the fact)", async () => {
    const [n, ground] = await Promise.all(
      [5, 6].map((fill) => generateEphemeralKey(new Uint8Array(32).fill(fill))),
    );
    const commit = await sasCommitment(n!.publicKey, start);
    expect(await verifySasCommitment(commit, ground!.publicKey, start)).toBe(false);
    expect(await verifySasCommitment(commit, n!.publicKey, { ...start, label: "attacker" })).toBe(
      false,
    );
  });
});

describe(acceptanceTitle(6), () => {
  it("refuses binding_seq below the pinned seq, and an older root epoch", async () => {
    const { world, descriptor, pin } = await setup();
    const seen = { ...pin, binding_seq: 2 };
    await expect(
      verifyBindingForPin(descriptorEvidence(descriptor), seen, context),
    ).resolves.toMatchObject({ ok: false, code: "rollback" });
    const later = await signStatement(
      "ServerBinding",
      { ...world.binding.body, binding_seq: 2 },
      world.root,
    );
    await expect(
      verifyBindingForPin(descriptorEvidence({ ...descriptor, binding: later }), seen, context),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyBindingForPin(descriptorEvidence(descriptor), { ...pin, root_epoch: 2 }, context),
    ).resolves.toMatchObject({
      ok: false,
      code: "wrong_epoch",
    });
  });
});

describe(acceptanceTitle(7), () => {
  it("refuses linking and re-pinning unless the channel is direct loopback", async () => {
    const { world } = await setup();
    expect(
      linkClaw({ claw_id: world.state.claw_id, root_pub: world.mallory.pub }, "tunnel"),
    ).toEqual({ ok: false, code: "not_local_operator" });
    expect(repinRoot(world.state, world.mallory.pub, "tunnel")).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect(repinRoot(world.state, world.mallory.pub, "mailbox")).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect(repinRoot(world.state, world.mallory.pub, "local_operator")).toMatchObject({
      ok: true,
      state: { anchor: { root_epoch: 2 } },
    });
  });
});

describe(acceptanceTitle(10), () => {
  it("keeps the secret out of the request target", () => {
    const { invite_id, secret } = generateInviteSecret();
    const link = new URL(
      buildInviteLink(WORLD_HOST, { invite_id, secret, root_fp: `fp:${"ab".repeat(32)}` }),
    );
    const requestTarget = `${link.pathname}${link.search}`;
    expect(requestTarget).toBe("/join");
    expect(link.hash).toContain(invite_id);
  });

  it("refuses a second redemption of the same invite", async () => {
    const { state, redemption, identity } = await inviteFixture();
    const first = await submitRedemption(state, redemption, identity, WORLD_NOW);
    expect(first).toMatchObject({ ok: true, status: "pending" });
    const again = await submitRedemption(first.state, redemption, identity, WORLD_NOW);
    expect(again).toMatchObject({ ok: false, code: "invite_used" });
  });
});
