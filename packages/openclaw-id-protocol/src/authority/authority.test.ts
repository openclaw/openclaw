import { describe, expect, it } from "vitest";
import { fingerprint } from "../keys.js";
import { buildWorld, signChange, WORLD_NOW } from "../testing/world.js";
import { submitStatement } from "./apply.js";
import { isAdmitted, linkClaw, snapshotBody } from "./state.js";

describe("reference membership authority", () => {
  it("links only over direct loopback and admits owner devices from their certificates", async () => {
    const world = await buildWorld();
    expect(linkClaw({ claw_id: world.state.claw_id, root_pub: world.rootPub }, "tunnel")).toEqual({
      ok: false,
      code: "not_local_operator",
    });
    expect(
      isAdmitted(world.state, world.device2.peer, await fingerprint(world.device2.peer), WORLD_NOW),
    ).toBe(true);
    expect(
      isAdmitted(world.state, world.mallory.peer, await fingerprint(world.mallory.peer), WORLD_NOW),
    ).toBe(false);
    expect(snapshotBody(world.state, 1, WORLD_NOW).owner_peer_keys).toHaveLength(2);
  });

  it("adds and removes a member directly, with disconnect and run-cancel events", async () => {
    const world = await buildWorld();
    const chain = [{ ...world.cert1, chain: [] }];
    const add = await signChange(world.state, world.device1.signer, chain, {
      op: "add",
      account_id: "acct_bob",
      role: "viewer",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    });
    const added = await submitStatement(world.state, add, { channel: "tunnel", now: WORLD_NOW });
    expect(added).toMatchObject({ ok: true, status: "applied" });
    const remove = await signChange(added.state, world.device1.signer, chain, {
      op: "remove",
      account_id: "acct_bob",
    });
    const removed = await submitStatement(added.state, remove, {
      channel: "tunnel",
      now: WORLD_NOW,
    });
    expect(removed.ok && removed.events.map((event) => event.type)).toEqual([
      "disconnect",
      "invalidate_tokens",
      "cancel_runs",
      "publish_snapshot",
    ]);
    expect(
      isAdmitted(
        removed.state,
        world.invitee.peer,
        await fingerprint(world.invitee.peer),
        WORLD_NOW,
      ),
    ).toBe(false);
  });
});
