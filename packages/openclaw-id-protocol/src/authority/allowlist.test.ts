// The allowlist model: approval by a current owner device, removal with every device it
// approved, inactivity drops without a cascade, per-claw caps, and history-free snapshots.
import { describe, expect, it } from "vitest";
import { fingerprint, type IrohEndpointKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import {
  MAX_MEMBER_PEER_KEYS,
  MAX_MEMBERS,
  MAX_OWNER_DEVICES,
  type MembershipTarget,
} from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  buildWorld,
  certBody,
  signChange,
  signRevocation,
  worldKey,
  WORLD_NOW,
} from "../testing/world.js";
import { dropInactive, nextInactivityDrop, recordSeen } from "./allowlist.js";
import { submitStatement, type WriteContext } from "./apply.js";
import { isAdmitted, snapshotBody, type AuthorityState } from "./state.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const mailbox = { channel: "mailbox" as const, now: WORLD_NOW };
const DAY = 86400;

type World = Awaited<ReturnType<typeof buildWorld>>;
type Key = World["device1"];

// Applies a write and fails loudly when it is refused.
async function apply(state: AuthorityState, statement: unknown, context: WriteContext = tunnel) {
  const result = await submitStatement(state, statement, context);
  if (!result.ok) {
    throw new Error(`refused: ${result.code} ${result.detail}`);
  }
  return result;
}

// `approver` approves `device` as an owner device at the claw (signs cert and change).
async function approve(state: AuthorityState, approver: Key, device: Key) {
  const cert = await signStatement("OwnerDeviceCert", certBody(device), approver.signer);
  return submitStatement(
    state,
    await signChange(state, approver.signer, { op: "add_owner_device", cert }),
    tunnel,
  );
}

// An owner-device Revocation of `target` at the claw's current seq, signed by `signer`.
async function revocation(state: AuthorityState, target: Key, signer: Key) {
  return signRevocation(state, signer.signer, await fingerprint(target.pub));
}

describe("owner device approval", () => {
  it("records who approved each device", async () => {
    const world = await buildWorld();
    const fp1 = await fingerprint(world.device1.pub);
    const fp2 = await fingerprint(world.device2.pub);
    expect(world.state.owner_devices[fp1]?.approved_by).toBe("root");
    expect(world.state.owner_devices[fp2]?.approved_by).toBe(fp1);
  });

  it("accepts approval by a current owner device and refuses it from a removed one", async () => {
    const world = await buildWorld();
    const device3 = await worldKey("device-3");
    const removed = await apply(
      world.state,
      await revocation(world.state, world.device2, world.device1),
    );
    const refused = await approve(removed.state, world.device2, device3);
    expect(refused).toMatchObject({ ok: false, code: "not_an_owner" });
    const accepted = await approve(removed.state, world.device1, device3);
    expect(accepted.ok).toBe(true);
    expect(isAdmitted(accepted.state, device3.peer, WORLD_NOW)).toBe(true);
  });

  it("refuses a statement signed by a removed owner device", async () => {
    const world = await buildWorld();
    const removed = await apply(
      world.state,
      await revocation(world.state, world.device2, world.device1),
    );
    const change = await signChange(removed.state, world.device2.signer, {
      op: "add",
      account_id: "acct_bob",
      role: "viewer",
      peer_keys: [world.invitee.peer],
      invite_id: null,
    });
    await expect(submitStatement(removed.state, change, tunnel)).resolves.toMatchObject({
      ok: false,
      code: "not_an_owner",
    });
  });
});

describe("revocation", () => {
  it("removes a device with every device it approved, transitively, and disconnects them", async () => {
    const world = await buildWorld();
    const device3 = await worldKey("device-3");
    const added = await approve(world.state, world.device2, device3);
    expect(added.ok).toBe(true);
    const result = await apply(
      added.state,
      await revocation(added.state, world.device2, world.device1),
    );
    expect(Object.keys(result.state.owner_devices)).toEqual([await fingerprint(world.device1.pub)]);
    const cut = [world.device2.peer, device3.peer].toSorted();
    expect(result.events).toEqual([
      { type: "disconnect", peer_keys: expect.arrayContaining(cut) },
      { type: "invalidate_tokens", peer_keys: expect.arrayContaining(cut) },
      { type: "publish_snapshot" },
    ]);
    expect(isAdmitted(result.state, device3.peer, WORLD_NOW)).toBe(false);
  });

  it("removes the approved device when the approver revokes itself, and keeps nothing", async () => {
    const world = await buildWorld();
    const result = await apply(
      world.state,
      await revocation(world.state, world.device1, world.device1),
    );
    expect(result.state.owner_devices).toEqual({});
    expect(result.state).not.toHaveProperty("revoked");
  });

  it("is a no-op for a device the claw no longer lists, also through the mailbox", async () => {
    const world = await buildWorld();
    const once = await apply(
      world.state,
      await revocation(world.state, world.device2, world.device1),
      mailbox,
    );
    const again = await apply(
      once.state,
      await revocation(once.state, world.device2, world.device1),
      mailbox,
    );
    expect(again.state).toBe(once.state);
    expect(again.events).toEqual([]);
  });

  it("removes a member browser by peer key; the member stays listed", async () => {
    const world = await buildWorld();
    const added = await apply(
      world.state,
      await signChange(world.state, world.device1.signer, {
        op: "add",
        account_id: "acct_bob",
        role: "viewer",
        peer_keys: [world.invitee.peer],
        invite_id: null,
      }),
    );
    const removed = await apply(
      added.state,
      await signChange(added.state, world.device1.signer, {
        op: "revoke_device",
        peer_key: world.invitee.peer,
      }),
    );
    expect(removed.state.members.acct_bob).toMatchObject({ peer_keys: [], last_seen: {} });
    expect(isAdmitted(removed.state, world.invitee.peer, WORLD_NOW)).toBe(false);
  });
});

describe("inactivity", () => {
  it("drops an idle owner device after the window without dropping the devices it approved", async () => {
    const world = await buildWorld();
    const later = WORLD_NOW + 91 * DAY;
    const seen = recordSeen(world.state, world.device2.peer, WORLD_NOW + 2 * DAY)!;
    expect(seen).not.toBeNull();
    const dropped = dropInactive(seen, later)!;
    expect(dropped.peers).toEqual([world.device1.peer]);
    expect(Object.keys(dropped.state.owner_devices)).toEqual([
      await fingerprint(world.device2.pub),
    ]);
    expect(isAdmitted(dropped.state, world.device2.peer, later)).toBe(true);
  });

  it("honours configurable windows and reports when the next drop is due", async () => {
    const world = await buildWorld();
    const windows = { ownerDeviceSeconds: 10, memberPeerKeySeconds: 5 };
    expect(dropInactive(world.state, WORLD_NOW + 10, windows)).toBeNull();
    expect(nextInactivityDrop(world.state, windows)).toBe(WORLD_NOW + 11);
    expect(dropInactive(world.state, WORLD_NOW + 11, windows)?.state.owner_devices).toEqual({});
  });

  it("drops a member peer key after 30 idle days and keeps an active one", async () => {
    const world = await buildWorld();
    const extra = await worldKey("extra");
    const added = await apply(
      world.state,
      await signChange(world.state, world.device1.signer, {
        op: "add",
        account_id: "acct_bob",
        role: "viewer",
        peer_keys: [world.invitee.peer, extra.peer],
        invite_id: null,
      }),
    );
    const active = recordSeen(added.state, extra.peer, WORLD_NOW + 20 * DAY)!;
    const fresh = recordSeen(active, world.device1.peer, WORLD_NOW + 20 * DAY)!;
    const all = recordSeen(fresh, world.device2.peer, WORLD_NOW + 20 * DAY)!;
    const dropped = dropInactive(all, WORLD_NOW + 31 * DAY)!;
    expect(dropped.peers).toEqual([world.invitee.peer]);
    expect(dropped.state.members.acct_bob?.peer_keys).toEqual([extra.peer]);
  });

  it("moves last_seen only past the resolution and ignores unknown keys", async () => {
    const world = await buildWorld();
    expect(recordSeen(world.state, world.device1.peer, WORLD_NOW + 60)).toBeNull();
    expect(recordSeen(world.state, world.mallory.peer, WORLD_NOW + 7200)).toBeNull();
  });
});

describe("caps", () => {
  it(`refuses a ${MAX_OWNER_DEVICES + 1}th owner device`, async () => {
    const world = await buildWorld();
    let state = world.state;
    for (let index = 2; index < MAX_OWNER_DEVICES; index += 1) {
      const result = await approve(state, world.device1, await worldKey(`owner-${index}`));
      if (!result.ok) {
        throw new Error(result.detail);
      }
      state = result.state;
    }
    expect(Object.keys(state.owner_devices)).toHaveLength(MAX_OWNER_DEVICES);
    const refused = await approve(state, world.device1, await worldKey("one-too-many"));
    expect(refused).toMatchObject({ ok: false, code: "limit_reached", state });
  });

  it(`refuses a ${MAX_MEMBERS + 1}th member and a ${MAX_MEMBER_PEER_KEYS + 1}th member browser`, async () => {
    const world = await buildWorld();
    const add = (state: AuthorityState, account: string, peers: IrohEndpointKey[]) =>
      signChange(state, world.device1.signer, {
        op: "add",
        account_id: account,
        role: "viewer",
        peer_keys: peers,
        invite_id: null,
      } satisfies MembershipTarget);
    let state = world.state;
    for (let index = 0; index < MAX_MEMBERS; index += 1) {
      const key = await worldKey(`member-${index}`);
      state = (await apply(state, await add(state, `acct_${index}`, [key.peer]))).state;
    }
    const extra = await worldKey("member-extra");
    await expect(
      submitStatement(state, await add(state, "acct_extra", [extra.peer]), tunnel),
    ).resolves.toMatchObject({ ok: false, code: "limit_reached" });
    const browsers = await Promise.all(
      Array.from({ length: MAX_MEMBER_PEER_KEYS }, (_, index) => worldKey(`browser-${index}`)),
    );
    await expect(
      submitStatement(
        state,
        await add(
          state,
          "acct_0",
          browsers.map((key) => key.peer),
        ),
        tunnel,
      ),
    ).resolves.toMatchObject({ ok: false, code: "limit_reached" });
  });
});

describe("snapshot", () => {
  it("lists current owner devices and members only, with no revoked list", async () => {
    const world = await buildWorld();
    const removed = await apply(
      world.state,
      await revocation(world.state, world.device2, world.device1),
    );
    const body = snapshotBody(removed.state, 1, WORLD_NOW);
    expect(body).not.toHaveProperty("revoked");
    expect(body.owner_devices).toEqual([
      { device_pub: world.device1.pub, caps: [...world.cert1.body.caps].toSorted() },
    ]);
    expect(body.owner_peer_keys).toEqual([world.device1.peer]);
    const signed = await signStatement("MembershipSnapshot", body, world.gateway.signer);
    expect(parseStatement(signed, "MembershipSnapshot")).toMatchObject({ ok: true });
    expect(
      parseStatement({ ...signed, body: { ...body, revoked: [] } }, "MembershipSnapshot"),
    ).toMatchObject({ ok: false });
  });
});
