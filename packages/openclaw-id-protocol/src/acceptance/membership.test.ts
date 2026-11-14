// Spec section 11 acceptance tests 3, 4, 8, 9, 11 and 12 (Gateway membership authority side).
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/v1-draft/statements.json" with { type: "json" };
import { registerInvite, submitRedemption, submitStatement } from "../authority/apply.js";
import {
  activeOwnerDevices,
  isAdmitted,
  snapshotBody,
  type AuthorityState,
} from "../authority/state.js";
import { fingerprint, formatEd25519PublicKey, type IrohEndpointKey } from "../keys.js";
import { decodeKit, deriveRootSigner, encodeKit } from "../kit.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin } from "../statements/pin.js";
import type { SignedStatement } from "../statements/types.js";
import { verifyOwnerStatement } from "../statements/verify.js";
import { acceptanceTitle } from "../testing/acceptance.js";
import type { StatementVectors } from "../testing/vectors.js";
import {
  buildWorld,
  certBody,
  signChange,
  worldKey,
  WORLD_HOST,
  WORLD_KIT_SECRET,
  WORLD_NOW,
} from "../testing/world.js";
import { FIXTURE_INVITE_ID, inviteFixture } from "./invite-fixture.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const mailbox = { channel: "mailbox" as const, now: WORLD_NOW };

async function admitted(state: AuthorityState, peer: IrohEndpointKey): Promise<boolean> {
  return isAdmitted(state, peer, WORLD_NOW);
}

async function addBob(world: Awaited<ReturnType<typeof buildWorld>>) {
  const change = await signChange(world.state, world.device1.signer, {
    op: "add",
    account_id: "acct_bob",
    role: "operator",
    peer_keys: [world.invitee.peer],
    invite_id: null,
  });
  const result = await submitStatement(world.state, change, tunnel);
  expect(result.ok).toBe(true);
  return result.state;
}

describe(acceptanceTitle(3), () => {
  it("refuses a MembershipChange signed by a key that is not an owner device", async () => {
    const world = await buildWorld();
    const target = {
      op: "add" as const,
      account_id: "acct_mallory",
      role: "operator" as const,
      peer_keys: [world.mallory.peer],
      invite_id: null,
    };
    const unsigned = await signChange(world.state, world.mallory.signer, target);
    await expect(submitStatement(world.state, unsigned, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "not_an_owner",
    });
    await expect(submitStatement(world.state, unsigned, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "not_an_owner",
    });
    const tampered = await signChange(world.state, world.device1.signer, {
      ...target,
      peer_keys: [world.invitee.peer],
    });
    const swapped = { ...tampered, body: { ...tampered.body, target } };
    await expect(submitStatement(world.state, swapped, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "bad_signature",
    });
  });

  it("refuses a genuine device-signed change delivered through Discovery, and a replay", async () => {
    const world = await buildWorld();
    const change = await signChange(world.state, world.device1.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "viewer",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    });
    await expect(submitStatement(world.state, change, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "not_direct",
    });
    const applied = await submitStatement(world.state, change, tunnel);
    await expect(submitStatement(applied.state, change, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
  });

  it("refuses a forged InviteCap, and any InviteCap that arrives through the mailbox", async () => {
    const { world, cap, proofKey } = await inviteFixture();
    const forged = await signStatement(
      "InviteCap",
      { ...cap.body, invite_id: "2e".repeat(16) },
      world.mallory.signer,
    );
    await expect(registerInvite(world.state, forged, proofKey, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "not_an_owner",
    });
    await expect(registerInvite(world.state, cap, proofKey, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "not_direct",
    });
  });

  it("refuses an invite signed by a removed owner device (shared vector)", async () => {
    const vectors = fixture as unknown as StatementVectors;
    const removed = vectors.invalid.find(
      (entry) => entry.name === "invite signed by a removed owner device",
    )!;
    const owners = new Map(vectors.owners.map((owner) => [owner.device_pub, owner.caps]));
    const result = await verifyOwnerStatement(
      removed.statement as SignedStatement<"InviteCap">,
      vectors.anchor,
      { now: vectors.now, owners: (key) => owners.get(key) },
    );
    expect(result).toMatchObject({ ok: false, code: "not_an_owner" });
  });
});

describe(acceptanceTitle(4), () => {
  it("a removed member is refused by admission even while Discovery still serves the old snapshot", async () => {
    const world = await buildWorld();
    const withBob = await addBob(world);
    const staleSnapshot = snapshotBody(withBob, 1, WORLD_NOW);
    const remove = await signChange(withBob, world.device1.signer, {
      op: "remove",
      account_id: "acct_bob",
    });
    const removed = await submitStatement(withBob, remove, tunnel);
    expect(removed.ok && removed.events).toContainEqual({
      type: "disconnect",
      peer_keys: [world.invitee.peer],
    });
    expect(staleSnapshot.members.map((member) => member.account_id)).toContain("acct_bob");
    expect(await admitted(removed.state, world.invitee.peer)).toBe(false);
  });

  it("revoking an owner device also removes the devices it approved", async () => {
    const world = await buildWorld();
    const revocation = await signStatement(
      "Revocation",
      {
        target_fp: await fingerprint(world.device1.pub),
        target_kind: "owner_device",
        reason: "lost",
        root_epoch: 1,
        issued_at: WORLD_NOW - 5,
      },
      world.root,
    );
    const result = await submitStatement(world.state, revocation, mailbox);
    expect(result.ok).toBe(true);
    expect(await admitted(result.state, world.device1.peer)).toBe(false);
    expect(await admitted(result.state, world.device2.peer)).toBe(false);
  });
});

describe(acceptanceTitle(8), () => {
  it("kit enrollment adds the new device as approved by the root and notifies owners", async () => {
    const world = await buildWorld();
    const root = await deriveRootSigner(await decodeKit(await encodeKit(WORLD_KIT_SECRET)));
    expect(formatEd25519PublicKey(root.publicKey)).toBe(world.rootPub);
    const phone = await worldKey("kit-phone");
    const phoneCert = await signStatement("OwnerDeviceCert", certBody(phone), root);
    const added = await submitStatement(
      world.state,
      await signChange(world.state, root, { op: "add_owner_device", cert: phoneCert }),
      mailbox,
    );
    expect(added.ok && added.events).toContainEqual({
      type: "notify_owners",
      event: "kit_used",
      ref: await fingerprint(phone.pub),
    });
    const fp = await fingerprint(phone.pub);
    expect(added.state.owner_devices[fp]?.approved_by).toBe("root");
    expect(activeOwnerDevices(added.state, WORLD_NOW)).toHaveLength(3);
    expect(await admitted(added.state, phone.peer)).toBe(true);
  });
});

describe(acceptanceTitle(9), () => {
  it("keeps the pinned root: rotations, other epochs and other roots are refused", async () => {
    const world = await buildWorld();
    const rootA = await worldKey("root-a");
    // RootRotation is not a statement type, whoever signs it.
    const rotation = await signStatement(
      "MembershipChange",
      {
        claw_id: world.state.claw_id,
        seq: 99,
        target: { op: "remove", account_id: "x" },
        issued_at: WORLD_NOW,
      },
      world.root,
    );
    const asRotation = { ...rotation, type: "RootRotation" };
    await expect(submitStatement(world.state, asRotation, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "malformed",
    });
    // root_epoch is the constant 1: anything else is malformed, even signed by R.
    const otherEpoch = await signStatement(
      "OwnerDeviceCert",
      { ...certBody(world.device1), root_epoch: 2 },
      world.root,
    );
    await expect(
      submitStatement(
        world.state,
        await signChange(world.state, world.root, { op: "add_owner_device", cert: otherEpoch }),
        { channel: "local_operator", now: WORLD_NOW },
      ),
    ).resolves.toMatchObject({ ok: false, code: "malformed" });
    // Another root is just another key: it is not R and not an owner device.
    const recert = await signStatement("OwnerDeviceCert", certBody(world.device1), rootA.signer);
    await expect(
      submitStatement(
        world.state,
        await signChange(world.state, rootA.signer, { op: "add_owner_device", cert: recert }),
        { channel: "local_operator", now: WORLD_NOW },
      ),
    ).resolves.toMatchObject({ ok: false, code: "not_an_owner" });
    // A client pinned to R refuses a binding from any other root.
    const binding = await signStatement(
      "ServerBinding",
      { ...world.binding.body, binding_seq: 2 },
      rootA.signer,
    );
    const pin = {
      claw_id: world.state.claw_id,
      root_fp: await fingerprint(world.rootPub),
      binding_seq: 1,
    };
    await expect(
      verifyBindingForPin({ root_pub: rootA.pub, binding }, pin, {
        now: WORLD_NOW,
        host: WORLD_HOST,
      }),
    ).resolves.toMatchObject({ ok: false, code: "root_mismatch" });
  });
});

describe(acceptanceTitle(11), () => {
  it("a redemption is only pending, admits nothing, and cannot be approved through Discovery", async () => {
    const { world, state, redemption, identity } = await inviteFixture();
    const pending = await submitRedemption(state, redemption, identity, WORLD_NOW);
    expect(pending).toMatchObject({ ok: true, status: "pending" });
    expect(await admitted(pending.state, world.invitee.peer)).toBe(false);
    const approve = await signChange(pending.state, world.device1.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "operator",
      peer_keys: [world.invitee.peer],
      invite_id: FIXTURE_INVITE_ID,
    });
    await expect(submitStatement(pending.state, approve, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "not_direct",
    });
    const direct = await submitStatement(pending.state, approve, tunnel);
    expect(direct).toMatchObject({ ok: true });
    expect(await admitted(direct.state, world.invitee.peer)).toBe(true);
    expect(direct.state.invites[FIXTURE_INVITE_ID]?.status).toBe("consumed");
  });

  it("refuses an approval that does not match the pending request, and a wrong audience", async () => {
    const { world, state, redemption, identity } = await inviteFixture();
    await expect(
      submitRedemption(state, redemption, { ...identity, email: "eve@example.com" }, WORLD_NOW),
    ).resolves.toMatchObject({
      ok: false,
      code: "audience_mismatch",
    });
    const pending = await submitRedemption(state, redemption, identity, WORLD_NOW);
    const wrongKey = await signChange(pending.state, world.device1.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "operator",
      peer_keys: [world.mallory.peer],
      invite_id: FIXTURE_INVITE_ID,
    });
    await expect(submitStatement(pending.state, wrongKey, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const deny = await signChange(pending.state, world.device1.signer, {
      op: "deny_invite",
      invite_id: FIXTURE_INVITE_ID,
    });
    const denied = await submitStatement(pending.state, deny, tunnel);
    expect(denied.state.invites[FIXTURE_INVITE_ID]?.status).toBe("consumed");
    // A denial bumps seq like any change, so the published snapshot must follow it.
    expect(denied.ok && denied.events).toContainEqual({ type: "publish_snapshot" });
    expect(await admitted(denied.state, world.invitee.peer)).toBe(false);
  });
});

describe(acceptanceTitle(12), () => {
  it("removing a member emits cancel_runs for that account", async () => {
    const world = await buildWorld();
    const withBob = await addBob(world);
    const remove = await signChange(withBob, world.device1.signer, {
      op: "remove",
      account_id: "acct_bob",
    });
    const removed = await submitStatement(withBob, remove, tunnel);
    expect(removed.ok && removed.events).toContainEqual({
      type: "cancel_runs",
      account_id: "acct_bob",
    });
  });
});
