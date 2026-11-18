// A revocation covers only the listings its signer saw: replaying the same bytes after the key
// is approved again changes nothing, while a fresh revocation, a device re-added while listed,
// and every device the target approved later are still covered.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import {
  buildWorld,
  certBody,
  signChange,
  signRevocation,
  worldKey,
  WORLD_NOW,
} from "../testing/world.js";
import { submitStatement, type WriteContext } from "./apply.js";
import { isAdmitted, type AuthorityState } from "./state.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const mailbox = { channel: "mailbox" as const, now: WORLD_NOW };

type Key = Awaited<ReturnType<typeof buildWorld>>["device1"];

// Applies a write and returns the new state, failing loudly when it is refused.
async function apply(state: AuthorityState, statement: unknown, context: WriteContext = tunnel) {
  const result = await submitStatement(state, statement, context);
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result.state;
}

// `approver` approves (or re-adds) `device` as an owner device, with `peers` as its peer keys.
async function approve(state: AuthorityState, approver: Key, device: Key, peers = [device.peer]) {
  const body = { ...certBody(device), peer_keys: peers };
  const cert = await signStatement("OwnerDeviceCert", body, approver.signer);
  return apply(state, await signChange(state, approver.signer, { op: "add_owner_device", cert }));
}

describe("revocation scope", () => {
  it("ignores a captured device revocation replayed after the device is approved again", async () => {
    const world = await buildWorld();
    const fp2 = await fingerprint(world.device2.pub);
    const captured = await signRevocation(world.state, world.device1.signer, fp2);
    const reapproved = await approve(
      await apply(world.state, captured, mailbox),
      world.device1,
      world.device2,
    );
    await expect(submitStatement(reapproved, captured, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "seq_conflict",
      events: [],
    });
    expect(isAdmitted(reapproved, world.device2.peer, WORLD_NOW)).toBe(true);
    const fresh = await signRevocation(reapproved, world.device1.signer, fp2);
    const removed = await apply(reapproved, fresh, mailbox);
    expect(isAdmitted(removed, world.device2.peer, WORLD_NOW)).toBe(false);
  });

  it("ignores a captured browser revocation replayed after the browser is added again", async () => {
    const world = await buildWorld();
    const add = async (state: AuthorityState) =>
      apply(
        state,
        await signChange(state, world.device1.signer, {
          op: "add",
          account_id: "acct_bob",
          role: "viewer",
          peer_keys: [world.invitee.peer],
          invite_id: null,
        }),
      );
    const withBob = await add(world.state);
    const browserFp = await fingerprint(world.invitee.peer);
    const captured = await signRevocation(withBob, world.device1.signer, browserFp, "peer_key");
    const readded = await add(await apply(withBob, captured, mailbox));
    await expect(submitStatement(readded, captured, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
    expect(isAdmitted(readded, world.invitee.peer, WORLD_NOW)).toBe(true);
  });

  it("covers a device re-added while listed and every device it approved later", async () => {
    const world = await buildWorld();
    const fp2 = await fingerprint(world.device2.pub);
    const signed = await signRevocation(world.state, world.device1.signer, fp2);
    const device3 = await worldKey("device-3");
    const readded = await approve(world.state, world.device1, world.device2);
    const result = await apply(await approve(readded, world.device2, device3), signed, mailbox);
    expect(Object.keys(result.owner_devices)).toEqual([await fingerprint(world.device1.pub)]);
    expect(isAdmitted(result, device3.peer, WORLD_NOW)).toBe(false);
  });

  it("matches an owner device's peer key by when the device was given that key", async () => {
    const world = await buildWorld();
    const extra = await worldKey("extra-browser");
    const before = world.state;
    const state = await approve(before, world.device1, world.device2, [
      world.device2.peer,
      extra.peer,
    ]);
    const newKey = await signRevocation(
      before,
      world.root,
      await fingerprint(extra.peer),
      "peer_key",
    );
    await expect(submitStatement(state, newKey, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
    const oldFp = await fingerprint(world.device2.peer);
    const oldKey = await signRevocation(before, world.root, oldFp, "peer_key");
    expect(isAdmitted(await apply(state, oldKey, mailbox), extra.peer, WORLD_NOW)).toBe(false);
  });

  it("keeps the earliest listing of a key copied into another record while listed", async () => {
    const world = await buildWorld();
    const peerFp = await fingerprint(world.device2.peer);
    const signed = await signRevocation(world.state, world.root, peerFp, "peer_key");
    const copy = await signChange(world.state, world.device2.signer, {
      op: "add",
      account_id: "acct_attacker",
      role: "operator",
      peer_keys: [world.device2.peer],
      invite_id: null,
    });
    const result = await apply(await apply(world.state, copy), signed, mailbox);
    expect(isAdmitted(result, world.device2.peer, WORLD_NOW)).toBe(false);
  });

  it("refuses a revocation for another claw or ahead of the claw's seq", async () => {
    const world = await buildWorld();
    const fp2 = await fingerprint(world.device2.pub);
    const signer = world.device1.signer;
    const ahead = await signRevocation(
      world.state,
      signer,
      fp2,
      "owner_device",
      world.state.seq + 1,
    );
    const other = await signRevocation({ ...world.state, claw_id: "f".repeat(32) }, signer, fp2);
    await expect(submitStatement(world.state, ahead, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
    await expect(submitStatement(world.state, other, mailbox)).resolves.toMatchObject({
      ok: false,
      code: "wrong_claw",
    });
  });
});
