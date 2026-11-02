// Spec section 11 acceptance tests 3, 4, 8, 9, 11 and 12 (Gateway membership authority side).
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/v1-draft/statements.json" with { type: "json" };
import {
  activeOwnerCerts,
  registerInvite,
  repinRoot,
  submitRedemption,
  submitStatement,
} from "../authority/apply.js";
import { isAdmitted, snapshotBody, type AuthorityState } from "../authority/state.js";
import { fingerprint, formatEd25519PublicKey, type IrohEndpointKey } from "../keys.js";
import { decodeKit, deriveRootSigner, encodeKit } from "../kit.js";
import { certificateChain, signStatement } from "../statements/envelope.js";
import type { SignedStatement } from "../statements/types.js";
import { verifyOwnerStatement } from "../statements/verify.js";
import { acceptanceTitle } from "../testing/acceptance.js";
import type { StatementVectors } from "../testing/vectors.js";
import {
  buildWorld,
  certBody,
  signChange,
  worldKey,
  WORLD_KIT_SECRET,
  WORLD_NOW,
} from "../testing/world.js";
import { FIXTURE_INVITE_ID, inviteFixture } from "./invite-fixture.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const mailbox = { channel: "mailbox" as const, now: WORLD_NOW };

async function admitted(state: AuthorityState, peer: IrohEndpointKey): Promise<boolean> {
  return isAdmitted(state, peer, await fingerprint(peer), WORLD_NOW);
}

async function addBob(world: Awaited<ReturnType<typeof buildWorld>>) {
  const change = await signChange(
    world.state,
    world.device1.signer,
    certificateChain(world.cert1),
    {
      op: "add",
      account_id: "acct_bob",
      role: "operator",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    },
  );
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
    const unsigned = await signChange(world.state, world.mallory.signer, [], target);
    await expect(submitStatement(world.state, unsigned, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "wrong_signer",
    });
    const selfCert = await signStatement(
      "OwnerDeviceCert",
      certBody(world.mallory),
      world.mallory.signer,
    );
    const fakeChain = await signChange(world.state, world.mallory.signer, [selfCert], target);
    await expect(submitStatement(world.state, fakeChain, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "chain_broken",
    });
    const tampered = await signChange(
      world.state,
      world.device1.signer,
      certificateChain(world.cert1),
      { ...target, peer_keys: [world.invitee.peer] },
    );
    const swapped = { ...tampered, body: { ...tampered.body, target } };
    await expect(submitStatement(world.state, swapped, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "bad_signature",
    });
  });

  it("refuses a genuine device-signed change delivered through Discovery, and a replay", async () => {
    const world = await buildWorld();
    const change = await signChange(
      world.state,
      world.device1.signer,
      certificateChain(world.cert1),
      {
        op: "add",
        account_id: "acct_bob",
        role: "viewer",
        peer_keys: [world.invitee.peer],
        invite_id: null,
      },
    );
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
      code: "wrong_signer",
    });
    await expect(registerInvite(world.state, cap, proofKey, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "not_direct",
    });
  });

  it("refuses chains deeper than four (shared vector)", async () => {
    const vectors = fixture as unknown as StatementVectors;
    const deep = vectors.invalid.find((entry) => entry.name === "chain deeper than 4")!;
    const result = await verifyOwnerStatement(
      deep.statement as SignedStatement<"InviteCap">,
      vectors.anchor,
      { now: vectors.now },
    );
    expect(result).toMatchObject({ ok: false, code: "chain_too_long" });
  });
});

describe(acceptanceTitle(4), () => {
  it("a removed member is refused by admission even while Discovery still serves the old snapshot", async () => {
    const world = await buildWorld();
    const withBob = await addBob(world);
    const staleSnapshot = snapshotBody(withBob, 1, WORLD_NOW);
    const remove = await signChange(withBob, world.device1.signer, certificateChain(world.cert1), {
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

  it("revoking an owner device also removes devices it certified", async () => {
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
  it("kit enrollment adds the new device, notifies owners, and leaves every chain at depth 0", async () => {
    const world = await buildWorld();
    expect(
      activeOwnerCerts(world.state, WORLD_NOW)
        .map((cert) => cert.chain.length)
        .toSorted((a, b) => a - b),
    ).toEqual([0, 1]);
    const root = await deriveRootSigner(await decodeKit(await encodeKit(WORLD_KIT_SECRET)));
    expect(formatEd25519PublicKey(root.publicKey)).toBe(world.rootPub);
    const phone = await worldKey("kit-phone");
    let state = world.state;
    for (const cert of activeOwnerCerts(state, WORLD_NOW)) {
      const recert = await signStatement(
        "OwnerDeviceCert",
        { ...cert.body, issued_at: WORLD_NOW - 1 },
        root,
      );
      const result = await submitStatement(state, recert, mailbox);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    const phoneCert = await signStatement("OwnerDeviceCert", certBody(phone), root);
    const added = await submitStatement(
      state,
      await signChange(state, root, [], { op: "add_owner_device", cert: phoneCert }),
      mailbox,
    );
    expect(added.ok && added.events).toContainEqual({
      type: "notify_owners",
      event: "kit_used",
      ref: await fingerprint(phone.pub),
    });
    expect(activeOwnerCerts(added.state, WORLD_NOW).map((cert) => cert.chain.length)).toEqual([
      0, 0, 0,
    ]);
    expect(await admitted(added.state, phone.peer)).toBe(true);
  });
});

describe(acceptanceTitle(9), () => {
  it("freezes on a second rotation out of the same epoch until the local operator re-pins", async () => {
    const world = await buildWorld();
    const [rootA, rootB] = await Promise.all([worldKey("root-a"), worldKey("root-b")]);
    const rotation = async (to: typeof rootA) =>
      signStatement(
        "RootRotation",
        {
          old_root_fp: await fingerprint(world.rootPub),
          new_root_pub: to.pub,
          new_epoch: 2,
          issued_at: WORLD_NOW - 5,
        },
        world.root,
      );
    // Only the local operator rotates the root; the conflict below may arrive from anywhere.
    const first = await submitStatement(world.state, await rotation(rootA), {
      channel: "local_operator",
      now: WORLD_NOW,
    });
    expect(first).toMatchObject({
      ok: true,
      state: { anchor: { root_pub: rootA.pub, root_epoch: 2 } },
    });
    const conflict = await submitStatement(first.state, await rotation(rootB), mailbox);
    expect(conflict).toMatchObject({
      ok: false,
      code: "conflicting_rotation",
      state: { frozen: true },
      persist: true,
    });
    expect(conflict.events).toContainEqual({
      type: "notify_owners",
      event: "rotation_conflict",
      ref: "2",
    });
    const recert = await signStatement("OwnerDeviceCert", certBody(world.device1, 2), rootA.signer);
    const blocked = await submitStatement(
      conflict.state,
      await signChange(conflict.state, rootA.signer, [], { op: "add_owner_device", cert: recert }),
      mailbox,
    );
    expect(blocked).toMatchObject({ ok: false, code: "frozen" });
    expect(repinRoot(conflict.state, rootA.pub, "tunnel")).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect(repinRoot(conflict.state, rootA.pub, "local_operator")).toMatchObject({
      ok: true,
      state: { frozen: false, anchor: { root_epoch: 3 } },
    });
  });
});

describe(acceptanceTitle(11), () => {
  it("a redemption is only pending, admits nothing, and cannot be approved through Discovery", async () => {
    const { world, state, redemption, identity } = await inviteFixture();
    const pending = await submitRedemption(state, redemption, identity, WORLD_NOW);
    expect(pending).toMatchObject({ ok: true, status: "pending" });
    expect(await admitted(pending.state, world.invitee.peer)).toBe(false);
    const approve = await signChange(
      pending.state,
      world.device1.signer,
      certificateChain(world.cert1),
      {
        op: "add",
        account_id: "acct_bob",
        role: "operator",
        peer_keys: [world.invitee.peer],
        invite_id: FIXTURE_INVITE_ID,
      },
    );
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
    const wrongKey = await signChange(
      pending.state,
      world.device1.signer,
      certificateChain(world.cert1),
      {
        op: "add",
        account_id: "acct_bob",
        role: "operator",
        peer_keys: [world.mallory.peer],
        invite_id: FIXTURE_INVITE_ID,
      },
    );
    await expect(submitStatement(pending.state, wrongKey, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const deny = await signChange(
      pending.state,
      world.device1.signer,
      certificateChain(world.cert1),
      { op: "deny_invite", invite_id: FIXTURE_INVITE_ID },
    );
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
    const remove = await signChange(withBob, world.device1.signer, certificateChain(world.cert1), {
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
