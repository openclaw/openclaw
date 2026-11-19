import { describe, expect, it } from "vitest";
import { inviteFixture } from "../acceptance/invite-fixture.js";
import { computeRedemptionProof } from "../invites.js";
import { fingerprint, formatIrohEndpointKey, rawPublicKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import type { MembershipTarget } from "../statements/types.js";
import { signChange, worldKey, WORLD_NOW } from "../testing/world.js";
import { dropInactive } from "./allowlist.js";
import { submitRedemption, submitStatement } from "./apply.js";
import { isAdmitted, snapshotBody } from "./state.js";

const direct = { channel: "tunnel", now: WORLD_NOW } as const;
const mailbox = { channel: "mailbox", now: WORLD_NOW } as const;
async function setup() {
  const f = await inviteFixture();
  const pending = await submitRedemption(f.state, f.redemption, f.identity, WORLD_NOW);
  const joined = await submitStatement(
    pending.state,
    await signChange(pending.state, f.world.root, {
      op: "add",
      account_id: f.identity.account_id,
      role: f.cap.body.role,
      peer_keys: [f.world.invitee.peer],
      invite_id: f.redemption.body.invite_id,
    }),
    direct,
  );
  expect(joined.ok).toBe(true);
  const kit = await worldKey("member-recovery-kit");
  const browser = await worldKey("recovered-browser");
  const set: MembershipTarget = {
    op: "set_member_recovery_kit",
    account_id: f.identity.account_id,
    device_pub: kit.pub,
  };
  const saved = await submitStatement(
    joined.state,
    await signChange(joined.state, f.world.invitee.signer, set),
    direct,
  );
  expect(saved.ok).toBe(true);
  const add: MembershipTarget = {
    op: "add_member_device",
    account_id: f.identity.account_id,
    peer_key: browser.peer,
    device_pub: browser.pub,
    label: "Recovered browser",
  };
  return { ...f, joined, kit, browser, set, add, state: saved.state };
}

describe("member recovery-only device authority", () => {
  it("recovers the invited account and role without admitting the kit key", async () => {
    const f = await setup();
    expect(f.state.members[f.identity.account_id]?.recovery_kit).toEqual({
      device_pub: f.kit.pub,
      saved_at: WORLD_NOW - 10,
    });
    expect(isAdmitted(f.state, formatIrohEndpointKey(rawPublicKey(f.kit.pub)), WORLD_NOW)).toBe(
      false,
    );
    expect(snapshotBody(f.state, 1, WORLD_NOW).members[0]?.peer_keys).not.toContain(
      formatIrohEndpointKey(rawPublicKey(f.kit.pub)),
    );
    const recovered = await submitStatement(
      f.state,
      await signChange(f.state, f.kit.signer, f.add),
      mailbox,
    );
    expect(recovered.ok).toBe(true);
    expect(isAdmitted(recovered.state, f.browser.peer, WORLD_NOW)).toBe(true);
    expect(recovered.state.members[f.identity.account_id]).toMatchObject({
      role: "operator",
      devices: {
        [f.browser.peer]: {
          approved_by: { kind: "member_recovery_kit", device_fp: await fingerprint(f.kit.pub) },
        },
      },
    });
    expect(recovered.events).toContainEqual({
      type: "notify_owners",
      event: "member_device_added",
      ref: await fingerprint(f.browser.peer),
    });
    const idle = dropInactive(f.state, WORLD_NOW + 40 * 86400);
    expect(idle?.state.members[f.identity.account_id]?.recovery_kit?.device_pub).toBe(f.kit.pub);
    expect(isAdmitted(idle!.state, f.world.invitee.peer, WORLD_NOW)).toBe(false);
    expect(
      (
        await submitStatement(
          idle!.state,
          await signChange(idle!.state, f.kit.signer, f.add),
          mailbox,
        )
      ).ok,
    ).toBe(true);
  });

  it("refuses strangers, cross-account recovery, role changes and replay without effects", async () => {
    const f = await setup();
    const changes: Array<[typeof f.kit, MembershipTarget]> = [
      [f.world.mallory, f.add],
      [f.kit, { ...f.add, account_id: "another-member" }],
      [f.kit, { op: "set_role", account_id: f.identity.account_id, role: "admin" }],
      [f.kit, { op: "remove", account_id: f.identity.account_id }],
      [f.kit, { op: "revoke_device", peer_key: f.world.invitee.peer }],
      [f.kit, f.set],
      [
        f.kit,
        {
          op: "add",
          account_id: "stranger",
          role: "admin",
          peer_keys: [f.browser.peer],
          invite_id: null,
        },
      ],
    ];
    for (const [signer, target] of changes) {
      expect(
        await submitStatement(f.state, await signChange(f.state, signer.signer, target), mailbox),
      ).toMatchObject({ ok: false, state: f.state, events: [] });
    }
    const change = await signChange(f.state, f.kit.signer, f.add);
    const recovered = await submitStatement(f.state, change, mailbox);
    expect(await submitStatement(recovered.state, change, mailbox)).toMatchObject({
      ok: false,
      code: "seq_conflict",
      state: recovered.state,
      events: [],
    });
    expect(
      await submitStatement(
        f.state,
        await signChange(f.state, f.world.invitee.signer, f.add),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_direct" });
    expect(
      await submitStatement(
        f.joined.state,
        await signChange(f.joined.state, f.world.invitee.signer, f.set),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_direct" });
  });

  it("replaces or deletes a kit without removing its existing browsers", async () => {
    const f = await setup();
    const recovered = await submitStatement(
      f.state,
      await signChange(f.state, f.kit.signer, f.add),
      mailbox,
    );
    const nextKit = await worldKey("replacement-member-kit");
    const replacement = await signStatement(
      "MembershipChange",
      {
        claw_id: recovered.state.claw_id,
        seq: recovered.state.seq + 1,
        issued_at: WORLD_NOW - 2,
        target: { ...f.set, device_pub: nextKit.pub },
      },
      f.browser.signer,
    );
    const replaced = await submitStatement(recovered.state, replacement, direct);
    expect(replaced.state.members[f.identity.account_id]?.recovery_kit).toEqual({
      device_pub: nextKit.pub,
      saved_at: WORLD_NOW - 2,
    });
    expect(replaced.ok).toBe(true);
    expect(isAdmitted(replaced.state, f.browser.peer, WORLD_NOW)).toBe(true);
    expect(
      await submitStatement(
        replaced.state,
        await signChange(replaced.state, f.kit.signer, f.add),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_an_owner" });
    const cleared = await submitStatement(
      replaced.state,
      await signChange(replaced.state, f.browser.signer, { ...f.set, device_pub: null }),
      direct,
    );
    expect(cleared.ok).toBe(true);
    expect(cleared.state.members[f.identity.account_id]?.recovery_kit).toBeUndefined();
    expect(
      await submitStatement(
        cleared.state,
        await signChange(cleared.state, nextKit.signer, f.add),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_an_owner" });
  });

  it("deletes the kit with membership and never restores it on reinvitation", async () => {
    const f = await setup();
    const removed = await submitStatement(
      f.state,
      await signChange(f.state, f.world.root, { op: "remove", account_id: f.identity.account_id }),
      direct,
    );
    expect(removed.ok).toBe(true);
    expect(removed.state.members[f.identity.account_id]).toBeUndefined();
    expect(
      await submitStatement(
        removed.state,
        await signChange(removed.state, f.kit.signer, f.add),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_an_owner" });
    const readded = await submitStatement(
      removed.state,
      await signChange(removed.state, f.world.root, {
        op: "add",
        account_id: f.identity.account_id,
        role: "viewer",
        peer_keys: [f.world.invitee.peer],
        invite_id: null,
      }),
      direct,
    );
    expect(readded.ok).toBe(true);
    expect(readded.state.members[f.identity.account_id]?.recovery_kit).toBeUndefined();
    expect(
      await submitStatement(
        readded.state,
        await signChange(readded.state, f.kit.signer, f.add),
        mailbox,
      ),
    ).toMatchObject({ ok: false, code: "not_an_owner" });
  });

  it.each([false, true])(
    "refuses kit D in invite approval, including a pending redemption before registration (%s)",
    async (pendingFirst) => {
      const f = await inviteFixture();
      const kit = await worldKey("invite-collision-kit");
      const parts = {
        claw_id: f.state.claw_id,
        invite_id: f.cap.body.invite_id,
        account_id: f.identity.account_id,
        device_pub: kit.pub,
        peer_key: kit.peer,
      };
      const redemption = await signStatement(
        "InviteRedemption",
        {
          ...parts,
          label: "Collision",
          proof: await computeRedemptionProof(f.proofKey, parts),
          requested_at: WORLD_NOW,
        },
        kit.signer,
      );
      let state = f.state;
      const added = await submitStatement(
        state,
        await signChange(state, f.world.root, {
          op: "add",
          account_id: f.identity.account_id,
          role: "operator",
          peer_keys: [f.world.invitee.peer],
          invite_id: null,
        }),
        direct,
      );
      expect(added.ok).toBe(true);
      state = added.state;
      const set: MembershipTarget = {
        op: "set_member_recovery_kit",
        account_id: f.identity.account_id,
        device_pub: kit.pub,
      };
      if (pendingFirst) {
        state = (await submitRedemption(state, redemption, f.identity, WORLD_NOW)).state;
      }
      const saved = await submitStatement(
        state,
        await signChange(state, f.world.root, set),
        direct,
      );
      expect(saved.ok).toBe(true);
      state = saved.state;
      if (!pendingFirst) {
        state = (await submitRedemption(state, redemption, f.identity, WORLD_NOW)).state;
      }
      expect(state.invites[f.cap.body.invite_id]?.pending).not.toBeNull();
      const approval = await signChange(state, f.world.root, {
        op: "add",
        account_id: f.identity.account_id,
        role: "operator",
        peer_keys: [kit.peer],
        invite_id: f.cap.body.invite_id,
      });
      expect(await submitStatement(state, approval, direct)).toMatchObject({
        ok: false,
        code: "target_mismatch",
        state,
        events: [],
      });
    },
  );

  it("refuses existing browser or owner/root signing keys as kits and kits as browser D/W", async () => {
    const f = await setup();
    for (const device_pub of [f.world.rootPub, f.world.device1.pub, f.world.invitee.pub]) {
      expect(
        await submitStatement(
          f.state,
          await signChange(f.state, f.world.invitee.signer, { ...f.set, device_pub }),
          direct,
        ),
      ).toMatchObject({ ok: false, state: f.state });
    }
    for (const target of [
      { ...f.add, device_pub: f.kit.pub },
      { ...f.add, peer_key: formatIrohEndpointKey(rawPublicKey(f.kit.pub)) },
    ]) {
      expect(
        await submitStatement(
          f.state,
          await signChange(f.state, f.world.invitee.signer, target),
          direct,
        ),
      ).toMatchObject({ ok: false, state: f.state });
    }
  });
});
