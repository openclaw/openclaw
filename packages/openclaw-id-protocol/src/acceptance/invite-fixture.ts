// Shared setup for invite acceptance tests: device-1 registers an operator invite for Bob.
import { registerInvite } from "../authority/apply.js";
import {
  computeRedemptionProof,
  deriveInviteProofKey,
  inviteSecretHash,
  type AssertedIdentity,
} from "../invites.js";
import { certificateChain, signStatement } from "../statements/envelope.js";
import { buildWorld, WORLD_NOW } from "../testing/world.js";

/** Invite id used by the fixture. */
export const FIXTURE_INVITE_ID = "1e".repeat(16);

/** A world with a registered invite, plus Bob's signed redemption request. */
export async function inviteFixture() {
  const world = await buildWorld();
  const secret = new Uint8Array(32).fill(9);
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signStatement(
    "InviteCap",
    {
      claw_id: world.state.claw_id,
      invite_id: FIXTURE_INVITE_ID,
      role: "operator",
      audience: { kind: "email", value: "bob@example.com" },
      label: "Bob",
      created_at: WORLD_NOW - 60,
      expires_at: WORLD_NOW + 86400,
      single_use: true,
      secret_hash: await inviteSecretHash(proofKey),
    },
    world.device1.signer,
    certificateChain(world.cert1),
  );
  const registered = await registerInvite(world.state, cap, proofKey, {
    channel: "tunnel",
    now: WORLD_NOW,
  });
  if (!registered.ok) {
    throw new Error(`invite registration refused: ${registered.code}`);
  }
  const parts = {
    claw_id: world.state.claw_id,
    invite_id: FIXTURE_INVITE_ID,
    account_id: "acct_bob",
    device_pub: world.invitee.pub,
    peer_key: world.invitee.peer,
  };
  const redemption = await signStatement(
    "InviteRedemption",
    { ...parts, proof: await computeRedemptionProof(proofKey, parts), requested_at: WORLD_NOW },
    world.invitee.signer,
  );
  const identity: AssertedIdentity = { account_id: "acct_bob", email: "bob@example.com" };
  return { world, state: registered.state, cap, proofKey, redemption, identity };
}
