// Regressions for the second ClawSweeper review of the protocol package (openclaw/openclaw#191469):
// schema lookups use own properties only, and re-adding an owner device with new peer keys tears
// down the old ones.
import { describe, expect, it } from "vitest";
import { submitStatement } from "./authority/apply.js";
import { signStatement } from "./statements/envelope.js";
import { parseStatement } from "./statements/validate.js";
import { buildWorld, certBody, signChange, worldKey, WORLD_NOW } from "./testing/world.js";

const tunnel = { channel: "tunnel" as const, now: WORLD_NOW };

describe("ClawSweeper review regressions, round 2", () => {
  it("returns malformed for a MembershipChange whose op names an Object.prototype member", async () => {
    const world = await buildWorld();
    const change = await signChange(world.state, world.device1.signer, {
      op: "remove",
      account_id: "acct_bob",
    });
    for (const op of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const forged = { ...change, body: { ...change.body, target: { op } } };
      expect(() => parseStatement(forged, "MembershipChange")).not.toThrow();
      expect(parseStatement(forged, "MembershipChange")).toMatchObject({
        ok: false,
        code: "malformed",
      });
      await expect(submitStatement(world.state, forged, tunnel)).resolves.toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
  });

  it("refuses an undeclared constructor field, even one holding a lone surrogate", async () => {
    const world = await buildWorld();
    for (const value of ["\ud800", "x", {}]) {
      const body: Record<string, unknown> = structuredClone(world.cert2.body);
      Object.defineProperty(body, "constructor", { value, enumerable: true });
      const forged = { ...world.cert2, body };
      expect(parseStatement(forged, "OwnerDeviceCert")).toMatchObject({
        ok: false,
        code: "malformed",
      });
      // The same certificate nested in an untrusted change is refused before canonicalization.
      const change = await signChange(world.state, world.device1.signer, {
        op: "add_owner_device",
        cert: world.cert2,
      });
      const nested = {
        ...change,
        body: { ...change.body, target: { op: "add_owner_device", cert: forged } },
      };
      await expect(submitStatement(world.state, nested, tunnel)).resolves.toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
  });

  it("tears down the old peer keys when a re-add replaces an owner device's peer keys", async () => {
    const world = await buildWorld();
    const w2 = (await worldKey("device-2-new-browser")).peer;
    const cert = await signStatement(
      "OwnerDeviceCert",
      { ...certBody(world.device2), peer_keys: [w2] },
      world.device1.signer,
    );
    const result = await submitStatement(
      world.state,
      await signChange(world.state, world.device1.signer, { op: "add_owner_device", cert }),
      tunnel,
    );
    expect(result.ok && result.events).toEqual([
      { type: "disconnect", peer_keys: [world.device2.peer] },
      { type: "invalidate_tokens", peer_keys: [world.device2.peer] },
      { type: "publish_snapshot" },
    ]);
    const same = await submitStatement(
      world.state,
      await signChange(world.state, world.device1.signer, {
        op: "add_owner_device",
        cert: await signStatement("OwnerDeviceCert", certBody(world.device2), world.device1.signer),
      }),
      tunnel,
    );
    expect(same.ok && same.events).toEqual([{ type: "publish_snapshot" }]);
  });
});
