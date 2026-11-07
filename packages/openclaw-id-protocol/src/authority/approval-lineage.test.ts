// Re-adding an owner device keeps who approved it and cannot raise its caps: a delegated device
// cannot move itself or another device out from under its approver, or attach its peer key to a
// device outside its own approval subtree, to survive that approver's revocation. An old
// R-signed certificate carried by an owner device's change grants nothing.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import type { OwnerCapability, SignedStatement } from "../statements/types.js";
import {
  buildWorld,
  certBody,
  signChange,
  signRevocation,
  worldKey,
  WORLD_NOW,
} from "../testing/world.js";
import { submitStatement } from "./apply.js";
import { isAdmitted, type AuthorityState } from "./state.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const local = { channel: "local_operator" as const, now: WORLD_NOW };

type World = Awaited<ReturnType<typeof buildWorld>>;
type Key = World["device1"];
type Signer = Key["signer"];
type Cert = SignedStatement<"OwnerDeviceCert">;

// Submits `cert` in an add_owner_device change signed by `changeSigner`.
async function submitCert(state: AuthorityState, changeSigner: Signer, cert: Cert) {
  return submitStatement(
    state,
    await signChange(state, changeSigner, { op: "add_owner_device", cert }),
    tunnel,
  );
}

// `approver` certifies `device` with `caps` and submits the change itself.
async function grant(
  state: AuthorityState,
  approver: Signer,
  device: Key,
  caps?: OwnerCapability[],
) {
  const cert = await signStatement("OwnerDeviceCert", certBody(device, caps), approver);
  return submitCert(state, approver, cert);
}

// Unwraps an accepted write's state; fails loudly when it was refused.
function accepted(result: Awaited<ReturnType<typeof submitStatement>>): AuthorityState {
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result.state;
}

// R revokes `device` (and, by the cascade, every device it approved).
async function rootRevokes(world: World, state: AuthorityState, device: Key) {
  const revocation = await signRevocation(state, world.root, await fingerprint(device.pub));
  return accepted(await submitStatement(state, revocation, local));
}

describe("owner device approval lineage", () => {
  it("keeps a delegated device under its approver when it re-certifies itself", async () => {
    const world = await buildWorld();
    const fp1 = await fingerprint(world.device1.pub);
    const fp2 = await fingerprint(world.device2.pub);
    // device-2 (approved by device-1) re-adds itself; the update is allowed, the reparent is not.
    const state = accepted(await grant(world.state, world.device2.signer, world.device2));
    expect(state.owner_devices[fp2]?.approved_by).toBe(fp1);
    const revoked = await rootRevokes(world, state, world.device1);
    expect(revoked.owner_devices[fp2]).toBeUndefined();
    expect(isAdmitted(revoked, world.device2.peer, WORLD_NOW)).toBe(false);
  });

  it("refuses two delegated devices re-certifying each other", async () => {
    const world = await buildWorld();
    const device3 = await worldKey("device-3");
    const state = accepted(await grant(world.state, world.device1.signer, device3));
    await expect(grant(state, world.device2.signer, device3)).resolves.toMatchObject({
      ok: false,
      code: "target_mismatch",
      state,
    });
    await expect(grant(state, device3.signer, world.device2)).resolves.toMatchObject({
      ok: false,
      code: "target_mismatch",
      state,
    });
    const revoked = await rootRevokes(world, state, world.device1);
    expect(Object.keys(revoked.owner_devices)).toEqual([]);
  });

  it("refuses a delegated device attaching its peer key to a device outside its subtree", async () => {
    const world = await buildWorld();
    const independent = await worldKey("independent");
    const state = accepted(await grant(world.state, world.root, independent));
    // device-2 (under device-1) lowers the independent device's caps and adds its own peer key.
    const grafted = {
      ...certBody(independent, ["approve_device"]),
      peer_keys: [independent.peer, world.device2.peer],
    };
    const cert = await signStatement("OwnerDeviceCert", grafted, world.device2.signer);
    await expect(submitCert(state, world.device2.signer, cert)).resolves.toMatchObject({
      ok: false,
      code: "target_mismatch",
      state,
    });
    const revoked = await rootRevokes(world, state, world.device1);
    expect(isAdmitted(revoked, world.device2.peer, WORLD_NOW)).toBe(false);
    expect(isAdmitted(revoked, independent.peer, WORLD_NOW)).toBe(true);
  });

  it("lets a device update one it approved, which stays under its approver", async () => {
    const world = await buildWorld();
    const fp1 = await fingerprint(world.device1.pub);
    const fp2 = await fingerprint(world.device2.pub);
    const state = accepted(
      await grant(world.state, world.device1.signer, world.device2, ["approve_device"]),
    );
    expect(state.owner_devices[fp2]).toMatchObject({ approved_by: fp1, caps: ["approve_device"] });
    const revoked = await rootRevokes(world, state, world.device1);
    expect(isAdmitted(revoked, world.device2.peer, WORLD_NOW)).toBe(false);
  });

  it("lets R re-anchor a listed device", async () => {
    const world = await buildWorld();
    const fp2 = await fingerprint(world.device2.pub);
    const state = accepted(await grant(world.state, world.root, world.device2));
    expect(state.owner_devices[fp2]?.approved_by).toBe("root");
    const revoked = await rootRevokes(world, state, world.device1);
    expect(isAdmitted(revoked, world.device2.peer, WORLD_NOW)).toBe(true);
  });
});

describe("certificates carried by an owner device's change", () => {
  it("refuses an old R-signed certificate that would undo a reduction of caps", async () => {
    const world = await buildWorld();
    const device = await worldKey("reduced");
    const fp = await fingerprint(device.pub);
    // R grants every cap with a certificate that never expires; the device keeps it.
    const original = await signStatement("OwnerDeviceCert", certBody(device), world.root);
    let state = accepted(await submitCert(world.state, world.root, original));
    // R lowers the device to caps that still include approve_device.
    state = accepted(await grant(state, world.root, device, ["approve_device"]));
    expect(state.owner_devices[fp]?.caps).toEqual(["approve_device"]);
    // The device signs a fresh, correctly sequenced change carrying the original certificate.
    await expect(submitCert(state, device.signer, original)).resolves.toMatchObject({
      ok: false,
      code: "wrong_signer",
      state,
    });
    // A fresh R-signed change can still raise the caps.
    const raised = accepted(await grant(state, world.root, device));
    expect(raised.owner_devices[fp]?.caps).toEqual(certBody(device).caps);
  });

  it("refuses an old R-signed certificate re-listing a removed device through an owner device", async () => {
    const world = await buildWorld();
    const removed = await worldKey("removed");
    const original = await signStatement("OwnerDeviceCert", certBody(removed), world.root);
    let state = accepted(await submitCert(world.state, world.root, original));
    state = await rootRevokes(world, state, removed);
    const limited = await worldKey("limited");
    state = accepted(await grant(state, world.root, limited, ["approve_device"]));
    // Without the check this would list the device with every cap, approved by R.
    await expect(submitCert(state, limited.signer, original)).resolves.toMatchObject({
      ok: false,
      code: "wrong_signer",
      state,
    });
  });

  it("refuses a certificate signed by another owner device than the change", async () => {
    const world = await buildWorld();
    const device3 = await worldKey("device-3");
    const cert = await signStatement("OwnerDeviceCert", certBody(device3), world.device1.signer);
    await expect(submitCert(world.state, world.device2.signer, cert)).resolves.toMatchObject({
      ok: false,
      code: "wrong_signer",
    });
  });

  it("refuses a device-signed certificate carried by an R-signed change", async () => {
    const world = await buildWorld();
    const device3 = await worldKey("device-3");
    const cert = await signStatement("OwnerDeviceCert", certBody(device3), world.device1.signer);
    await expect(submitCert(world.state, world.root, cert)).resolves.toMatchObject({
      ok: false,
      code: "wrong_signer",
    });
  });
});
