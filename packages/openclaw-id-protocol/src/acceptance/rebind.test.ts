// Re-bind (enrollment.md, "Re-bind"): R signs a ServerBinding at a higher binding_seq naming
// new K_srv and K_gw. There is no new statement type; these are the existing rules a re-bind
// relies on, from the client's pin to the retirement of everything the old K_gw signed.
import { describe, expect, it } from "vitest";
import { snapshotBody } from "../authority/state.js";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin, type ClawPin } from "../statements/pin.js";
import { verifyMembershipSnapshot } from "../statements/verify.js";
import { buildWorld, WORLD_HOST, WORLD_NOW, worldKey } from "../testing/world.js";

const context = { now: WORLD_NOW, host: WORLD_HOST };

async function rebound() {
  const world = await buildWorld();
  const pin: ClawPin = {
    claw_id: world.state.claw_id,
    root_fp: await fingerprint(world.rootPub),
    binding_seq: 1,
    k_gw: world.gateway.pub,
  };
  // A re-bind to keys `name`, at `seq`.
  const rebind = async (name: string, seq: number) => {
    const keys = await worldKey(name);
    const binding = await signStatement(
      "ServerBinding",
      {
        ...world.binding.body,
        k_srv: keys.peer,
        k_gw: keys.pub,
        binding_seq: seq,
        issued_at: WORLD_NOW,
      },
      world.root,
    );
    return { keys, binding };
  };
  return { world, pin, rebind };
}

describe("re-bind to new machine keys under the same root", () => {
  it("a binding at binding_seq + 1 with new keys verifies and moves the pin to the new K_gw", async () => {
    const { world, pin, rebind } = await rebound();
    const next = await rebind("gateway-2", 2);
    const checked = await verifyBindingForPin(
      { root_pub: world.rootPub, binding: next.binding },
      pin,
      context,
    );
    expect(checked).toMatchObject({
      ok: true,
      binding: { k_srv: next.keys.peer, k_gw: next.keys.pub },
      pin: { binding_seq: 2, k_gw: next.keys.pub },
    });
  });

  it("a client that missed several re-binds verifies the newest directly", async () => {
    const { world, pin, rebind } = await rebound();
    await rebind("gateway-2", 2);
    const newest = await rebind("gateway-3", 3);
    expect(
      await verifyBindingForPin({ root_pub: world.rootPub, binding: newest.binding }, pin, context),
    ).toMatchObject({ ok: true, pin: { binding_seq: 3, k_gw: newest.keys.pub } });
  });

  it("the old binding is a rollback once the pin moved", async () => {
    const { world, pin, rebind } = await rebound();
    const next = await rebind("gateway-2", 2);
    const moved = await verifyBindingForPin(
      { root_pub: world.rootPub, binding: next.binding },
      pin,
      context,
    );
    if (!moved.ok) {
      throw new Error(moved.detail);
    }
    expect(
      await verifyBindingForPin(
        { root_pub: world.rootPub, binding: world.binding },
        moved.pin,
        context,
      ),
    ).toMatchObject({ ok: false, code: "rollback" });
  });

  it("a snapshot signed by the retired K_gw does not verify under the new binding", async () => {
    const { world, rebind } = await rebound();
    const next = await rebind("gateway-2", 2);
    const retired = await signStatement(
      "MembershipSnapshot",
      snapshotBody(world.state, 2, WORLD_NOW),
      world.gateway.signer,
    );
    expect(await verifyMembershipSnapshot(retired, next.binding.body)).toMatchObject({
      ok: false,
      code: "wrong_signer",
    });
    const current = await signStatement(
      "MembershipSnapshot",
      snapshotBody(world.state, 2, WORLD_NOW),
      next.keys.signer,
    );
    expect(await verifyMembershipSnapshot(current, next.binding.body)).toMatchObject({ ok: true });
  });

  it("a RootReset signed by the retired K_gw is root_mismatch for a pin that saw the re-bind", async () => {
    const { world, pin, rebind } = await rebound();
    const next = await rebind("gateway-2", 2);
    const moved = await verifyBindingForPin(
      { root_pub: world.rootPub, binding: next.binding },
      pin,
      context,
    );
    if (!moved.ok) {
      throw new Error(moved.detail);
    }
    // Whoever kept the old K_gw (and a root of their own) vouches for a reset from the old binding.
    const attackerRoot = await worldKey("attacker-root");
    const statement = await signStatement(
      "RootReset",
      {
        claw_id: world.state.claw_id,
        new_root_pub: attackerRoot.pub,
        binding_seq: 3,
        issued_at: WORLD_NOW,
      },
      world.gateway.signer,
    );
    const binding = await signStatement(
      "ServerBinding",
      { ...world.binding.body, binding_seq: 3, issued_at: WORLD_NOW },
      attackerRoot.signer,
    );
    expect(
      await verifyBindingForPin(
        {
          root_pub: attackerRoot.pub,
          binding,
          reset: { previous_root_pub: world.rootPub, previous_binding: world.binding, statement },
        },
        moved.pin,
        context,
      ),
    ).toMatchObject({ ok: false, code: "root_mismatch" });
  });
});
