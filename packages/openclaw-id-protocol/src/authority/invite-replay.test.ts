import { describe, expect, it } from "vitest";
import { FIXTURE_INVITE_ID, inviteFixture } from "../acceptance/invite-fixture.js";
import { computeRedemptionProof } from "../invites.js";
import { signStatement } from "../statements/envelope.js";
import { signChange, WORLD_NOW } from "../testing/world.js";
import { submitRedemption, submitStatement } from "./apply.js";

const context = { channel: "tunnel" as const, now: WORLD_NOW };

async function approvedInvite() {
  const f = await inviteFixture();
  const pending = await submitRedemption(f.state, f.redemption, f.identity, WORLD_NOW);
  expect(pending.ok).toBe(true);
  const approval = await signChange(pending.state, f.world.device1.signer, {
    op: "add",
    account_id: f.identity.account_id,
    role: "operator",
    peer_keys: [f.world.invitee.peer],
    invite_id: FIXTURE_INVITE_ID,
  });
  const approved = await submitStatement(pending.state, approval, context);
  expect(approved.ok).toBe(true);
  return { ...f, state: approved.state };
}

describe("approved invite re-redemption", () => {
  it("accepts the same account and keys without changing state or emitting effects", async () => {
    const f = await approvedInvite();
    // A fresh signature/request timestamp from the same browser is also a replay.
    const again = await signStatement(
      "InviteRedemption",
      { ...f.redemption.body, requested_at: WORLD_NOW + 1 },
      f.world.invitee.signer,
    );
    const result = await submitRedemption(f.state, again, f.identity, WORLD_NOW + 1);
    expect(result).toMatchObject({ ok: true, status: "applied", events: [] });
    expect(result.state).toBe(f.state);
  });

  it.each(["account", "device", "peer"] as const)("refuses a different %s", async (changed) => {
    const f = await approvedInvite();
    const body = {
      ...f.redemption.body,
      ...(changed === "account" ? { account_id: "acct_other" } : {}),
      ...(changed === "device" ? { device_pub: f.world.mallory.pub } : {}),
      ...(changed === "peer" ? { peer_key: f.world.mallory.peer } : {}),
    };
    const redemption = await signStatement(
      "InviteRedemption",
      {
        ...body,
        proof: await computeRedemptionProof(f.proofKey, {
          claw_id: body.claw_id,
          invite_id: body.invite_id,
          account_id: body.account_id,
          device_pub: body.device_pub,
          peer_key: body.peer_key,
        }),
      },
      changed === "device" ? f.world.mallory.signer : f.world.invitee.signer,
    );
    const result = await submitRedemption(
      f.state,
      redemption,
      {
        ...f.identity,
        account_id: body.account_id,
      },
      WORLD_NOW,
    );
    expect(result).toMatchObject({ ok: false, code: "invite_used", events: [] });
    expect(result.state).toBe(f.state);
    expect(result.ok ? "" : result.detail).toContain(`invite_id=${FIXTURE_INVITE_ID}`);
    expect(result.ok ? "" : result.detail).toContain(`already_member=${changed !== "account"}`);
    expect(result.ok ? "" : result.detail).toContain(`keys_match=${changed === "account"}`);
  });

  it.each(["remove", "revoke_device"] as const)("does not undo %s", async (op) => {
    const f = await approvedInvite();
    const removed = await submitStatement(
      f.state,
      await signChange(
        f.state,
        f.world.device1.signer,
        op === "remove"
          ? { op, account_id: f.identity.account_id }
          : { op, peer_key: f.world.invitee.peer },
      ),
      context,
    );
    expect(removed.ok).toBe(true);
    const result = await submitRedemption(removed.state, f.redemption, f.identity, WORLD_NOW);
    expect(result).toMatchObject({ ok: false, code: "invite_used", events: [] });
    expect(result.state).toBe(removed.state);
  });

  it("still verifies the signature, proof and asserted identity of a matching replay", async () => {
    const f = await approvedInvite();
    const badProof = await signStatement(
      "InviteRedemption",
      { ...f.redemption.body, proof: "00".repeat(32) },
      f.world.invitee.signer,
    );
    for (const [redemption, identity, code] of [
      [
        { ...f.redemption, body: { ...f.redemption.body, requested_at: WORLD_NOW + 1 } },
        f.identity,
        "bad_signature",
      ],
      [badProof, f.identity, "bad_proof"],
      [f.redemption, { ...f.identity, account_id: "acct_other" }, "invite_used"],
    ] as const) {
      const result = await submitRedemption(f.state, redemption, identity, WORLD_NOW);
      expect(result).toMatchObject({ ok: false, code, events: [] });
      expect(result.state).toBe(f.state);
    }
  });

  it("does not accept pending, denied or historical consumed invites as approved", async () => {
    const f = await inviteFixture();
    const pending = await submitRedemption(f.state, f.redemption, f.identity, WORLD_NOW);
    const denied = await submitStatement(
      pending.state,
      await signChange(pending.state, f.world.device1.signer, {
        op: "deny_invite",
        invite_id: FIXTURE_INVITE_ID,
      }),
      context,
    );
    for (const state of [pending.state, denied.state]) {
      expect(await submitRedemption(state, f.redemption, f.identity, WORLD_NOW)).toMatchObject({
        ok: false,
        code: "invite_used",
      });
    }
    const admitted = await submitStatement(
      denied.state,
      await signChange(denied.state, f.world.device1.signer, {
        op: "add",
        account_id: f.identity.account_id,
        role: "operator",
        peer_keys: [f.world.invitee.peer],
        invite_id: null,
      }),
      context,
    );
    expect(admitted.ok).toBe(true);
    expect(
      await submitRedemption(admitted.state, f.redemption, f.identity, WORLD_NOW),
    ).toMatchObject({ ok: false, code: "invite_used" });
  });
});
