// Owner-key regeneration (OCF-319): the root is replaced only by the local operator on
// direct loopback; every older owner certificate stops working; certificates carry no
// expiry unless the approver enters one, and an explicit expiry is enforced.
import { describe, expect, it } from "vitest";
import { ownerDeviceCertBody } from "../enrollment/owner-cert.js";
import { signOwnerKeyRegeneration } from "../enrollment/regeneration.js";
import { fingerprint, type IrohEndpointKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { verifyOwnerStatement } from "../statements/verify.js";
import { buildWorld, signChange, worldKey, WORLD_HOST, WORLD_NOW } from "../testing/world.js";
import { submitStatement } from "./apply.js";
import { regenerateOwnerKey } from "./regenerate.js";
import { isAdmitted, isOwnerDeviceActive, type AuthorityState } from "./state.js";

const local = { channel: "local_operator" as const, now: WORLD_NOW };
const REMOTE = ["tunnel", "mailbox"] as const;

async function admitted(state: AuthorityState, peer: IrohEndpointKey, now = WORLD_NOW) {
  return isAdmitted(state, peer, await fingerprint(peer), now);
}

// A rotation out of the world's epoch 1, signed by the current root R.
async function rotation(world: Awaited<ReturnType<typeof buildWorld>>, to: string) {
  return signStatement(
    "RootRotation",
    {
      old_root_fp: await fingerprint(world.rootPub),
      new_root_pub: (await worldKey(to)).pub,
      new_epoch: 2,
      issued_at: WORLD_NOW - 5,
    },
    world.root,
  );
}

// The regenerating browser's statements for the world, signed by a new root R'.
async function regeneration(
  world: Awaited<ReturnType<typeof buildWorld>>,
  options: { rootName?: string; expiresAt?: number | null; epoch?: number } = {},
) {
  const [newRoot, browser] = await Promise.all([
    worldKey(options.rootName ?? "root-regenerated"),
    worldKey("loopback-browser"),
  ]);
  const statements = await signOwnerKeyRegeneration({
    preparation: {
      claw_id: world.state.claw_id,
      hostname: WORLD_HOST,
      k_srv: world.server.peer,
      k_gw: world.gateway.pub,
      binding_seq: 2,
      root_epoch: options.epoch ?? 2,
      seq: world.state.seq + 1,
    },
    root: newRoot.signer,
    device: { device_pub: browser.pub, peer_keys: [browser.peer], label: "loopback" },
    expiresAt: options.expiresAt,
    now: WORLD_NOW - 1,
  });
  return { newRoot, browser, statements };
}

describe("RootRotation is accepted only from the local operator", () => {
  it.each(REMOTE)("refuses a validly signed rotation over %s", async (channel) => {
    const world = await buildWorld();
    const result = await submitStatement(world.state, await rotation(world, "root-a"), {
      channel,
      now: WORLD_NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "not_local_operator" });
    expect(result.state).toBe(world.state);
    expect(result.events).toEqual([]);
  });

  it("accepts it on direct loopback and ends the old owner devices' sessions", async () => {
    const world = await buildWorld();
    const result = await submitStatement(world.state, await rotation(world, "root-a"), local);
    expect(result).toMatchObject({ ok: true, state: { anchor: { root_epoch: 2 } } });
    const ended = [world.device1.peer, world.device2.peer];
    expect(result.events).toContainEqual({ type: "disconnect", peer_keys: ended });
    expect(result.events).toContainEqual({ type: "invalidate_tokens", peer_keys: ended });
    expect(await admitted(result.state, world.device1.peer)).toBe(false);
  });

  it("still freezes on a conflicting rotation sent remotely", async () => {
    const world = await buildWorld();
    const first = await submitStatement(world.state, await rotation(world, "root-a"), local);
    const conflict = await submitStatement(first.state, await rotation(world, "root-b"), {
      channel: "tunnel",
      now: WORLD_NOW,
    });
    expect(conflict).toMatchObject({ ok: false, code: "conflicting_rotation", persist: true });
    expect(conflict.state.frozen).toBe(true);
  });
});

describe("owner-key regeneration", () => {
  it.each(REMOTE)("is refused over %s, even with valid statements", async (channel) => {
    const world = await buildWorld();
    const { newRoot, statements } = await regeneration(world);
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: newRoot.pub, owner_device: statements.ownerDevice },
      { channel, now: WORLD_NOW },
    );
    expect(result).toMatchObject({ ok: false, code: "not_local_operator" });
    expect(result.state).toBe(world.state);
  });

  it("starts a new epoch, invalidates every older owner device and enrolls the browser", async () => {
    const world = await buildWorld();
    const { newRoot, browser, statements } = await regeneration(world);
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: newRoot.pub, owner_device: statements.ownerDevice },
      local,
    );
    expect(result).toMatchObject({
      ok: true,
      state: { anchor: { root_pub: newRoot.pub, root_epoch: 2 }, frozen: false },
    });
    const state = result.state;
    expect(Object.keys(state.owner_devices)).toEqual([await fingerprint(browser.pub)]);
    expect(await admitted(state, world.device1.peer)).toBe(false);
    expect(await admitted(state, world.device2.peer)).toBe(false);
    expect(await admitted(state, browser.peer)).toBe(true);
    const ended = [world.device1.peer, world.device2.peer];
    expect(result.events).toEqual([
      { type: "disconnect", peer_keys: ended },
      { type: "invalidate_tokens", peer_keys: ended },
      { type: "publish_snapshot" },
    ]);
    // A statement an old owner device signs no longer verifies.
    const stale = await signChange(state, world.device1.signer, [world.cert1], {
      op: "set_role",
      account_id: "acct_bob",
      role: "viewer",
    });
    expect(
      await verifyOwnerStatement(stale, state.anchor, { now: WORLD_NOW, isRevoked: () => false }),
    ).toMatchObject({ ok: false, code: "chain_broken" });
  });

  it("unfreezes a claw frozen by conflicting rotations", async () => {
    const world = await buildWorld();
    const first = await submitStatement(world.state, await rotation(world, "root-a"), local);
    const conflict = await submitStatement(first.state, await rotation(world, "root-b"), {
      channel: "mailbox",
      now: WORLD_NOW,
    });
    const frozen = conflict.state;
    expect(frozen.frozen).toBe(true);
    const { newRoot, statements } = await regeneration({ ...world, state: frozen }, { epoch: 3 });
    const result = await regenerateOwnerKey(
      frozen,
      { root_pub: newRoot.pub, owner_device: statements.ownerDevice },
      local,
    );
    expect(result).toMatchObject({ ok: true, state: { frozen: false, anchor: { root_epoch: 3 } } });
  });

  it("refuses a root the claw has used before", async () => {
    const world = await buildWorld();
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: world.rootPub, owner_device: {} },
      local,
    );
    expect(result).toMatchObject({ ok: false, code: "root_reused" });
  });

  it("refuses an enrollment not signed by the new root alone", async () => {
    const world = await buildWorld();
    const { newRoot, statements } = await regeneration(world);
    const other = await regeneration(world, { rootName: "root-other" });
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: newRoot.pub, owner_device: other.statements.ownerDevice },
      local,
    );
    expect(result).toMatchObject({ ok: false, code: "target_mismatch" });
    expect(statements.ownerDevice.signer).toBe(newRoot.pub);
  });

  it("refuses an enrollment certificate from another epoch", async () => {
    const world = await buildWorld();
    const { newRoot, statements } = await regeneration(world, { epoch: 1 });
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: newRoot.pub, owner_device: statements.ownerDevice },
      local,
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.state).toBe(world.state);
  });
});

describe("owner certificate expiry is explicit", () => {
  const device = { device_pub: "ed25519:00" as const, label: "phone", root_epoch: 1 };

  it("defaults to no expiry", () => {
    expect(ownerDeviceCertBody({ ...device, now: WORLD_NOW }).expires_at).toBeNull();
    expect(ownerDeviceCertBody({ ...device, now: WORLD_NOW, expires_at: null }).expires_at).toBe(
      null,
    );
  });

  it("keeps an explicit future expiry and refuses one that is not after issue", () => {
    expect(
      ownerDeviceCertBody({ ...device, now: WORLD_NOW, expires_at: WORLD_NOW + 3600 }).expires_at,
    ).toBe(WORLD_NOW + 3600);
    expect(() => ownerDeviceCertBody({ ...device, now: WORLD_NOW, expires_at: WORLD_NOW })).toThrow(
      /explicit expiry/,
    );
  });

  it("enforces an explicit expiry on the regenerated device", async () => {
    const world = await buildWorld();
    const { newRoot, browser, statements } = await regeneration(world, {
      expiresAt: WORLD_NOW + 600,
    });
    const result = await regenerateOwnerKey(
      world.state,
      { root_pub: newRoot.pub, owner_device: statements.ownerDevice },
      local,
    );
    const record = Object.values(result.state.owner_devices)[0]!;
    expect(record.cert.body.expires_at).toBe(WORLD_NOW + 600);
    expect(isOwnerDeviceActive(result.state, record, WORLD_NOW)).toBe(true);
    expect(isOwnerDeviceActive(result.state, record, WORLD_NOW + 600)).toBe(false);
    expect(await admitted(result.state, browser.peer, WORLD_NOW + 600)).toBe(false);
  });

  it("issues regenerated certificates without expiry by default", async () => {
    const world = await buildWorld();
    const { statements } = await regeneration(world);
    const target = statements.ownerDevice.body.target;
    expect(target.op === "add_owner_device" && target.cert.body.expires_at).toBeNull();
  });
});
