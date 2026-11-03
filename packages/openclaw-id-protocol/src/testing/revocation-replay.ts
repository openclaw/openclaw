import { expect } from "vitest";
import { submitStatement, type WriteContext } from "../authority/apply.js";
import { isAdmitted, type AuthorityState } from "../authority/state.js";
import { fingerprint, type IrohEndpointKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { buildWorld, certBody, signChange, WORLD_NOW, type WorldKey } from "./world.js";

const tunnel: WriteContext = { channel: "tunnel", now: WORLD_NOW };
const mailbox: WriteContext = { channel: "mailbox", now: WORLD_NOW };

async function apply(state: AuthorityState, statement: unknown, context: WriteContext = tunnel) {
  const result = await submitStatement(state, statement, context);
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result;
}

async function ownerRevocation(target: WorldKey, signer: WorldKey) {
  return signStatement(
    "Revocation",
    {
      target_fp: await fingerprint(target.pub),
      target_kind: "owner_device",
      reason: "test",
      root_epoch: 1,
      issued_at: WORLD_NOW - 5,
    },
    signer.signer,
  );
}

async function peerRevocation(target: IrohEndpointKey, signer: WorldKey, issuedAt: number) {
  return signStatement(
    "Revocation",
    {
      target_fp: await fingerprint(target),
      target_kind: "peer_key",
      reason: "test",
      root_epoch: 1,
      issued_at: issuedAt,
    },
    signer.signer,
  );
}

async function replayCapturedRevocation(): Promise<void> {
  const world = await buildWorld();
  const signed = await ownerRevocation(world.device2, world.device1);
  const removed = await apply(world.state, signed, mailbox);
  const cert = await signStatement(
    "OwnerDeviceCert",
    { ...certBody(world.device2), issued_at: WORLD_NOW },
    world.device1.signer,
  );
  const restored = await apply(
    removed.state,
    await signChange(removed.state, world.device1.signer, { op: "add_owner_device", cert }),
  );
  const replay = await submitStatement(restored.state, signed, mailbox);
  expect(replay).toMatchObject({ ok: true, events: [] });
  expect(isAdmitted(restored.state, world.device2.peer, WORLD_NOW)).toBe(true);
}

async function revokeOwnerDespiteNewerCertificate(): Promise<void> {
  const world = await buildWorld();
  const cert = await signStatement(
    "OwnerDeviceCert",
    { ...certBody(world.device2), issued_at: WORLD_NOW + 120 },
    world.device1.signer,
  );
  const replaced = await apply(
    world.state,
    await signChange(world.state, world.device1.signer, { op: "add_owner_device", cert }),
  );
  const removed = await apply(
    replaced.state,
    await peerRevocation(world.device1.peer, world.device1, WORLD_NOW + 1),
  );
  expect(removed.state.owner_devices).toEqual({});
  expect(removed.events.map((event) => event.type)).toEqual([
    "disconnect",
    "invalidate_tokens",
    "publish_snapshot",
  ]);
}

async function revokeBrowserAheadOfGatewayClock(): Promise<void> {
  const world = await buildWorld();
  const gatewayNow = WORLD_NOW + 120;
  const added = await apply(
    world.state,
    await signChange(world.state, world.device1.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "viewer",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    }),
    { channel: "tunnel", now: gatewayNow },
  );
  const removed = await apply(
    added.state,
    await peerRevocation(world.invitee.peer, world.device1, WORLD_NOW + 1),
    { channel: "mailbox", now: gatewayNow },
  );
  expect(removed.state.members.acct_bob?.peer_keys).toEqual([]);
  expect(removed.events.map((event) => event.type)).toContain("invalidate_tokens");
}

export const revocationReplayCases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
  ["keeps a newer approval when an older revocation is submitted again", replayCapturedRevocation],
  ["still removes every device a revocable owner approved", revokeOwnerDespiteNewerCertificate],
  [
    "honours a revocation that is newer on the signer's clock than the add",
    revokeBrowserAheadOfGatewayClock,
  ],
];
