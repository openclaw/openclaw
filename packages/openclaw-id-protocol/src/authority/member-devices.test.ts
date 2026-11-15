import { describe, expect, it } from "vitest";
import { inviteFixture } from "../acceptance/invite-fixture.js";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { MAX_MEMBER_PEER_KEYS, type MembershipTarget } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyOwnerStatement } from "../statements/verify.js";
import { buildWorld, signChange, signRevocation, worldKey, WORLD_NOW } from "../testing/world.js";
import { submitRedemption, submitStatement } from "./apply.js";
import { memberLookup, snapshotBody } from "./state.js";

const context = { channel: "tunnel", now: WORLD_NOW } as const;
async function setup() {
  const world = await buildWorld();
  const extra = await worldKey("member-extra");
  const state = {
    ...world.state,
    members: {
      alice: {
        role: "operator",
        peer_keys: [world.invitee.peer],
        last_seen: { [world.invitee.peer]: WORLD_NOW },
        devices: {
          [world.invitee.peer]: {
            device_pub: world.invitee.pub,
            label: "Alice laptop",
            approved_by: { kind: "invite" as const, invite_id: "1".repeat(32) },
          },
        },
      },
      bob: { role: "viewer", peer_keys: [world.mallory.peer], last_seen: {} },
    },
  };
  const target = {
    op: "add_member_device",
    account_id: "alice",
    peer_key: extra.peer,
    device_pub: extra.pub,
    label: "Alice phone",
  } as const;
  return { ...world, state, extra, target };
}

describe("member device authority", () => {
  it("refuses a redemption whose signing or peer key is already listed", async () => {
    const { state, world, redemption, identity } = await inviteFixture();
    const pending = await submitRedemption(state, redemption, identity, WORLD_NOW);
    const sharedPeer = {
      ...pending.state,
      members: { alice: { role: "viewer", peer_keys: [world.invitee.peer], last_seen: {} } },
    };
    expect(
      await submitStatement(
        sharedPeer,
        await signChange(sharedPeer, world.root, {
          op: "add",
          account_id: identity.account_id,
          role: "operator",
          peer_keys: [world.invitee.peer],
          invite_id: redemption.body.invite_id,
        }),
        context,
      ),
    ).toMatchObject({ ok: false, code: "target_mismatch", state: sharedPeer });
    const duplicate = {
      ...pending.state,
      members: {
        other: {
          role: "viewer",
          peer_keys: [world.mallory.peer],
          last_seen: {},
          devices: {
            [world.mallory.peer]: {
              device_pub: world.invitee.pub,
              label: "Other",
              approved_by: { kind: "owner" as const, by: "root" as const },
            },
          },
        },
      },
    };
    expect(
      await submitStatement(
        duplicate,
        await signChange(duplicate, world.root, {
          op: "add",
          account_id: identity.account_id,
          role: "operator",
          peer_keys: [world.invitee.peer],
          invite_id: redemption.body.invite_id,
        }),
        context,
      ),
    ).toMatchObject({ ok: false, code: "target_mismatch", state: duplicate });
  });

  it("requires bounded labels and rejects a role on additional-device statements", async () => {
    const w = await setup();
    const { redemption } = await inviteFixture();
    const change = await signChange(w.state, w.invitee.signer, w.target);
    for (const label of [undefined, "x".repeat(257), "\ud800"]) {
      expect(parseStatement({ ...redemption, body: { ...redemption.body, label } }).ok).toBe(false);
      expect(
        parseStatement({ ...change, body: { ...change.body, target: { ...w.target, label } } }).ok,
      ).toBe(false);
    }
    expect(
      parseStatement({
        ...change,
        body: { ...change.body, target: { ...w.target, role: "admin" } },
      }).ok,
    ).toBe(false);
  });
  it("admits member, managing owner and root approvals without changing the role or snapshot shape", async () => {
    const w = await setup();
    for (const signer of [w.invitee.signer, w.device1.signer, w.root]) {
      const statement = await signChange(w.state, signer, w.target);
      const added = await submitStatement(w.state, statement, context);
      expect(added.ok).toBe(true);
      expect(added.state.members.alice).toMatchObject({
        role: "operator",
        peer_keys: [w.invitee.peer, w.extra.peer],
        devices: {
          [w.extra.peer]: {
            device_pub: w.extra.pub,
            label: "Alice phone",
            approved_by:
              signer === w.root
                ? { kind: "owner", by: "root" }
                : signer === w.device1.signer
                  ? { kind: "owner", by: await fingerprint(w.device1.pub) }
                  : { kind: "member_device", device_fp: await fingerprint(w.invitee.pub) },
          },
        },
      });
      expect(added.events).toEqual([
        { type: "publish_snapshot" },
        {
          type: "notify_owners",
          event: "member_device_added",
          ref: await fingerprint(w.extra.peer),
        },
      ]);
      expect(snapshotBody(added.state, 1, WORLD_NOW).members[0]).toEqual({
        account_id: "alice",
        role: "operator",
        peer_keys: [w.invitee.peer, w.extra.peer],
      });
    }
    const signed = await signChange(w.state, w.invitee.signer, w.target);
    expect(
      await verifyOwnerStatement(signed, w.state.anchor, {
        now: WORLD_NOW,
        members: memberLookup(w.state),
      }),
    ).toMatchObject({
      ok: true,
      authority: {
        kind: "member_device",
        account_id: "alice",
        device_pub: w.invitee.pub,
        peer_key: w.invitee.peer,
      },
    });
  });

  it("refuses unknown accounts, full accounts, reused peer keys and signing keys, and cross-account approvals", async () => {
    const w = await setup();
    const refused = async (
      state: typeof w.state,
      target: MembershipTarget,
      signer = w.root,
      code = "target_mismatch",
    ) => {
      const result = await submitStatement(state, await signChange(state, signer, target), context);
      expect(result).toMatchObject({ ok: false, code, state, events: [] });
    };
    await refused(w.state, { ...w.target, account_id: "unknown" });
    await refused(w.state, { ...w.target, account_id: "bob" }, w.invitee.signer);
    for (const peer_key of [w.invitee.peer, w.mallory.peer, w.device1.peer]) {
      await refused(w.state, { ...w.target, peer_key });
    }
    const nodeState = {
      ...w.state,
      nodes: {
        [w.extra.peer]: {
          label: "node",
          description: { display_name: "Node", platform: "linux", commands: [], caps: [] },
          listed_seq: 1,
          added_by: "root" as const,
          last_seen: WORLD_NOW,
        },
      },
    };
    await refused(nodeState, w.target);
    for (const device_pub of [w.device1.pub, w.invitee.pub]) {
      await refused(w.state, { ...w.target, device_pub });
    }
    const full = {
      ...w.state,
      members: {
        ...w.state.members,
        alice: {
          ...w.state.members.alice,
          peer_keys: await Promise.all(
            Array.from(
              { length: MAX_MEMBER_PEER_KEYS },
              async (_, i) => (await worldKey(`full-${i}`)).peer,
            ),
          ),
        },
      },
    };
    await refused(full, w.target, w.root, "limit_reached");
    const ownerFp = await fingerprint(w.device1.pub);
    await refused(
      {
        ...w.state,
        owner_devices: {
          ...w.state.owner_devices,
          [ownerFp]: { ...w.state.owner_devices[ownerFp]!, caps: ["invite"] },
        },
      },
      w.target,
      w.device1.signer,
      "missing_capability",
    );
    await refused(w.state, w.target, w.mallory.signer, "not_an_owner");
    const old = {
      ...w.state,
      members: { ...w.state.members, alice: { ...w.state.members.alice, devices: {} } },
    };
    await refused(old, w.target, w.invitee.signer, "not_an_owner");
  });

  it("limits member signatures to direct device operations, never other changes or Revocation", async () => {
    const w = await setup();
    const cert = Object.values(w.state.owner_devices)[0]!.cert;
    const targets: MembershipTarget[] = [
      {
        op: "add",
        account_id: "alice",
        role: "operator",
        peer_keys: [w.extra.peer],
        invite_id: null,
      },
      { op: "remove", account_id: "alice" },
      { op: "set_role", account_id: "alice", role: "admin" },
      { op: "add_owner_device", cert },
      { op: "deny_invite", invite_id: "1".repeat(32) },
      { op: "add_node", peer_key: w.extra.peer, label: "node", invite_id: "1".repeat(32) },
      { op: "remove_node", peer_key: w.extra.peer },
    ];
    for (const target of targets) {
      expect(
        await submitStatement(
          w.state,
          await signChange(w.state, w.invitee.signer, target),
          context,
        ),
      ).toMatchObject({ ok: false, code: "not_an_owner" });
    }
    for (const target of [w.target, { op: "revoke_device", peer_key: w.invitee.peer } as const]) {
      expect(
        await submitStatement(w.state, await signChange(w.state, w.invitee.signer, target), {
          ...context,
          channel: "mailbox",
        }),
      ).toMatchObject({ ok: false, code: "not_direct" });
    }
    for (const channel of ["tunnel", "mailbox"] as const) {
      expect(
        await submitStatement(
          w.state,
          await signRevocation(w.state, w.invitee.signer, await fingerprint(w.device1.pub)),
          { ...context, channel },
        ),
      ).toMatchObject({ ok: false, code: "not_an_owner" });
    }
    expect(
      await verifyOwnerStatement(
        await signStatement("OwnerDeviceCert", cert.body, w.invitee.signer),
        w.state.anchor,
        { now: WORLD_NOW, members: memberLookup(w.state) },
      ),
    ).toMatchObject({ ok: false, code: "not_an_owner" });
  });

  it("revokes another own device and its transitive approvals, but not the signer or other accounts", async () => {
    const w = await setup();
    const added = await submitStatement(
      w.state,
      await signChange(w.state, w.invitee.signer, w.target),
      context,
    );
    const grandchild = await worldKey("member-grandchild");
    const nested = await submitStatement(
      added.state,
      await signChange(added.state, w.extra.signer, {
        ...w.target,
        peer_key: grandchild.peer,
        device_pub: grandchild.pub,
      }),
      context,
    );
    expect(nested.ok).toBe(true);
    expect(
      await submitStatement(
        nested.state,
        await signChange(nested.state, w.extra.signer, {
          op: "revoke_device",
          peer_key: w.invitee.peer,
        }),
        context,
      ),
    ).toMatchObject({ ok: false, code: "target_mismatch" });
    const shared = {
      ...nested.state,
      members: {
        ...nested.state.members,
        bob: { ...nested.state.members.bob!, peer_keys: [w.extra.peer] },
      },
    };
    expect(
      await submitStatement(
        shared,
        await signChange(shared, w.invitee.signer, { op: "revoke_device", peer_key: w.extra.peer }),
        context,
      ),
    ).toMatchObject({ ok: false, code: "target_mismatch", state: shared });
    for (const peer_key of [w.invitee.peer, w.mallory.peer, w.device1.peer]) {
      expect(
        await submitStatement(
          nested.state,
          await signChange(nested.state, w.invitee.signer, { op: "revoke_device", peer_key }),
          context,
        ),
      ).toMatchObject({ ok: false, code: "target_mismatch", state: nested.state });
    }
    for (const signer of [w.invitee.signer, w.device1.signer, w.root]) {
      const removed = await submitStatement(
        nested.state,
        await signChange(nested.state, signer, { op: "revoke_device", peer_key: w.extra.peer }),
        context,
      );
      expect(removed.ok).toBe(true);
      expect(removed.state.members.alice?.peer_keys).toEqual([w.invitee.peer]);
      expect(Object.keys(removed.state.members.alice?.devices ?? {})).toEqual([w.invitee.peer]);
      expect(removed.events).toContainEqual({
        type: "disconnect",
        peer_keys: [w.extra.peer, grandchild.peer],
      });
      expect(removed.events).toContainEqual({
        type: "invalidate_tokens",
        peer_keys: [w.extra.peer, grandchild.peer],
      });
    }
    const revoked = await submitStatement(
      nested.state,
      await signRevocation(nested.state, w.root, await fingerprint(w.invitee.peer), "peer_key"),
      context,
    );
    expect(revoked.state.members.alice?.peer_keys).toEqual([]);
    expect(revoked.events).toContainEqual({
      type: "disconnect",
      peer_keys: [w.invitee.peer, w.extra.peer, grandchild.peer],
    });
  });
});
