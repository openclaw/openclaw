// Owner device certificate validity windows (OCF-278): a certificate, or any ancestor in
// its chain, that is expired or issued in the future grants no admission and no owner
// authority, and cannot be enrolled.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../keys.js";
import { certificateChain, signStatement } from "../statements/envelope.js";
import { buildWorld, certBody, signChange, WORLD_NOW } from "../testing/world.js";
import { activeOwnerCerts, submitStatement } from "./apply.js";
import {
  isAdmitted,
  linkClaw,
  nextOwnerExpiry,
  snapshotBody,
  type AuthorityState,
  type OwnerDeviceRecord,
} from "./state.js";

const local = { channel: "local_operator" as const, now: WORLD_NOW };
const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };

type World = Awaited<ReturnType<typeof buildWorld>>;

// Applies a setup write and fails loudly if it is refused.
async function apply(state: AuthorityState, statement: unknown, context = local) {
  const result = await submitStatement(state, statement, context);
  if (!result.ok) {
    throw new Error(`setup refused: ${result.code} ${result.detail}`);
  }
  return result.state;
}

// A claw whose owner device-1 is root-certified with `window`, plus device-2
// certified by device-1 without expiry.
async function clawWith(window: { issued_at?: number; expires_at: number | null }) {
  const world = await buildWorld();
  const linked = linkClaw(
    { claw_id: world.state.claw_id, root_pub: world.rootPub },
    "local_operator",
  );
  if (!linked.ok) {
    throw new Error("link failed");
  }
  const cert1 = await signStatement(
    "OwnerDeviceCert",
    { ...certBody(world.device1), ...window },
    world.root,
  );
  let state = await apply(
    linked.state,
    await signChange(linked.state, world.root, [], { op: "add_owner_device", cert: cert1 }),
  );
  const cert2 = await signStatement(
    "OwnerDeviceCert",
    certBody(world.device2),
    world.device1.signer,
    certificateChain(cert1),
  );
  state = await apply(
    state,
    await signChange(state, world.device1.signer, certificateChain(cert1), {
      op: "add_owner_device",
      cert: cert2,
    }),
    tunnel,
  );
  return { world, state };
}

async function admittedAt(state: AuthorityState, key: World["device1"], now: number) {
  return isAdmitted(state, key.peer, await fingerprint(key.peer), now);
}

describe("owner certificate validity windows", () => {
  it("stops admitting an owner device once its certificate expires", async () => {
    const { world, state } = await clawWith({ expires_at: WORLD_NOW + 100 });
    expect(await admittedAt(state, world.device1, WORLD_NOW)).toBe(true);
    expect(await admittedAt(state, world.device1, WORLD_NOW + 100)).toBe(false);
    expect(snapshotBody(state, 1, WORLD_NOW + 100).owner_peer_keys).not.toContain(
      world.device1.peer,
    );
    expect(activeOwnerCerts(state, WORLD_NOW + 100)).toHaveLength(0);
  });

  it("stops admitting a device whose parent certificate expired", async () => {
    const { world, state } = await clawWith({ expires_at: WORLD_NOW + 100 });
    expect(await admittedAt(state, world.device2, WORLD_NOW)).toBe(true);
    expect(await admittedAt(state, world.device2, WORLD_NOW + 101)).toBe(false);
  });

  it("does not admit a stored certificate issued in the future", async () => {
    const world = await buildWorld();
    const future = await signStatement(
      "OwnerDeviceCert",
      { ...certBody(world.mallory), issued_at: WORLD_NOW + 3600 },
      world.root,
    );
    const fp = await fingerprint(world.mallory.pub);
    const record: OwnerDeviceRecord = { cert: future, chain_fps: [fp] };
    const state = { ...world.state, owner_devices: { ...world.state.owner_devices, [fp]: record } };
    expect(await admittedAt(state, world.mallory, WORLD_NOW)).toBe(false);
    expect(await admittedAt(state, world.mallory, WORLD_NOW + 3600)).toBe(true);
  });

  it.each([
    ["expired", { expires_at: WORLD_NOW - 1 }],
    ["not_yet_valid", { issued_at: WORLD_NOW + 3600 }],
  ] as const)("refuses to enroll a certificate that is %s", async (code, window) => {
    const world = await buildWorld();
    const cert = await signStatement(
      "OwnerDeviceCert",
      { ...certBody(world.mallory), ...window },
      world.device1.signer,
      certificateChain(world.cert1),
    );
    const change = await signChange(
      world.state,
      world.device1.signer,
      certificateChain(world.cert1),
      {
        op: "add_owner_device",
        cert,
      },
    );
    const result = await submitStatement(world.state, change, tunnel);
    expect(result).toMatchObject({ ok: false, code, state: world.state });
  });

  it("refuses a root re-certification that is already expired", async () => {
    const world = await buildWorld();
    const recert = await signStatement(
      "OwnerDeviceCert",
      { ...certBody(world.device2), expires_at: WORLD_NOW - 1 },
      world.root,
    );
    expect(await submitStatement(world.state, recert, local)).toMatchObject({
      ok: false,
      code: "expired",
    });
  });

  it("reports the earliest expiry among active owner devices and their ancestors", async () => {
    const { state } = await clawWith({ expires_at: WORLD_NOW + 100 });
    expect(nextOwnerExpiry(state, WORLD_NOW)).toBe(WORLD_NOW + 100);
    expect(nextOwnerExpiry(state, WORLD_NOW + 100)).toBeNull();
    expect(nextOwnerExpiry((await buildWorld()).state, WORLD_NOW)).toBeNull();
  });
});
