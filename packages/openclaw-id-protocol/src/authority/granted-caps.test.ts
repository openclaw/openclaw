// Granted owner-device capabilities: an owner device may grant only what it holds, re-adding a
// listed device never raises its caps (R may grant anything), and the K_gw-signed snapshot
// carries each owner device's granted caps.
import { describe, expect, it } from "vitest";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import type { OwnerCapability } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyMembershipSnapshot } from "../statements/verify.js";
import { buildWorld, certBody, signChange, worldKey, WORLD_NOW } from "../testing/world.js";
import { submitStatement } from "./apply.js";
import { snapshotBody, type AuthorityState } from "./state.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };
const LIMITED: OwnerCapability[] = ["approve_device", "bind"];

type World = Awaited<ReturnType<typeof buildWorld>>;
type Key = World["device1"];

// `approver` signs a certificate for `device` granting `caps` and submits it over the tunnel.
async function grant(
  state: AuthorityState,
  approver: Key["signer"],
  device: Key,
  caps: OwnerCapability[],
) {
  const cert = await signStatement("OwnerDeviceCert", certBody(device, caps), approver);
  return submitStatement(
    state,
    await signChange(state, approver, { op: "add_owner_device", cert }),
    tunnel,
  );
}

// Adds `device` with `caps` approved by R and returns the new state.
async function addLimited(world: World, device: Key, caps: OwnerCapability[]) {
  const result = await grant(world.state, world.root, device, caps);
  if (!result.ok) {
    throw new Error(`refused: ${result.code}`);
  }
  return result.state;
}

describe("granted owner-device capabilities", () => {
  it("records the granted caps on the device record", async () => {
    const world = await buildWorld();
    const limited = await worldKey("limited");
    const state = await addLimited(world, limited, LIMITED);
    expect(state.owner_devices[await fingerprint(limited.pub)]?.caps).toEqual(LIMITED);
  });

  it("refuses an owner device granting caps it lacks, with caps_escalation", async () => {
    const world = await buildWorld();
    const limited = await worldKey("limited");
    const state = await addLimited(world, limited, LIMITED);
    const next = await worldKey("next");
    await expect(
      grant(state, limited.signer, next, ["approve_device", "bind", "invite"]),
    ).resolves.toMatchObject({ ok: false, code: "caps_escalation", state });
    const within = await grant(state, limited.signer, next, ["approve_device"]);
    expect(within.ok && within.state.owner_devices[await fingerprint(next.pub)]?.caps).toEqual([
      "approve_device",
    ]);
  });

  it("refuses a signer without approve_device", async () => {
    const world = await buildWorld();
    const binder = await worldKey("binder");
    const state = await addLimited(world, binder, ["bind"]);
    await expect(
      grant(state, binder.signer, await worldKey("next"), ["bind"]),
    ).resolves.toMatchObject({ ok: false, code: "missing_capability" });
  });

  it("never lets a re-add through an owner device raise a listed device's caps", async () => {
    const world = await buildWorld();
    const limited = await worldKey("limited");
    const added = await grant(world.state, world.device1.signer, limited, LIMITED);
    if (!added.ok) {
      throw new Error(`refused: ${added.code}`);
    }
    const state = added.state;
    // device1 approved the device and holds every cap, so the grant is within its own caps, but
    // above the device's.
    await expect(
      grant(state, world.device1.signer, limited, ["approve_device", "bind", "invite"]),
    ).resolves.toMatchObject({ ok: false, code: "caps_escalation", state });
    // A device re-adding itself cannot escalate either.
    await expect(
      grant(state, limited.signer, limited, ["approve_device", "bind", "invite"]),
    ).resolves.toMatchObject({ ok: false, code: "caps_escalation" });
    const lowered = await grant(state, world.device1.signer, limited, ["bind"]);
    expect(lowered.ok && lowered.state.owner_devices[await fingerprint(limited.pub)]?.caps).toEqual(
      ["bind"],
    );
  });

  it("lets R grant any caps, including raising a listed device", async () => {
    const world = await buildWorld();
    const limited = await worldKey("limited");
    const state = await addLimited(world, limited, LIMITED);
    const raised = await grant(state, world.root, limited, ["approve_device", "bind", "invite"]);
    expect(raised.ok && raised.state.owner_devices[await fingerprint(limited.pub)]?.caps).toEqual([
      "approve_device",
      "bind",
      "invite",
    ]);
  });

  it("round-trips the owner devices and their caps through a K_gw-signed snapshot", async () => {
    const world = await buildWorld();
    const limited = await worldKey("limited");
    const state = await addLimited(world, limited, ["bind", "approve_device"]);
    const body = snapshotBody(state, 1, WORLD_NOW);
    const signed = await signStatement("MembershipSnapshot", body, world.gateway.signer);
    const parsed = parseStatement(structuredClone(signed), "MembershipSnapshot");
    expect(parsed.ok).toBe(true);
    const listed = parsed.ok ? parsed.statement.body.owner_devices : [];
    expect(listed.find((device) => device.device_pub === limited.pub)?.caps).toEqual([
      "approve_device",
      "bind",
    ]);
    expect(listed.map((device) => device.device_pub)).toEqual(
      [world.device1.pub, world.device2.pub, limited.pub].toSorted(),
    );
    await expect(verifyMembershipSnapshot(signed, world.binding.body)).resolves.toMatchObject({
      ok: true,
    });
    const unknownCap = {
      ...signed,
      body: { ...body, owner_devices: [{ device_pub: limited.pub, caps: ["root"] }] },
    };
    expect(parseStatement(unknownCap, "MembershipSnapshot")).toMatchObject({
      ok: false,
      code: "malformed",
    });
  });
});
