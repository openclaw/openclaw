// Version negotiation (docs/versioning.md, "Choosing a version"): the Gateway advertises the
// versions it accepts in its K_gw-signed snapshot, and clients only use a list that passed
// assessFreshness, so Discovery can neither strip a version nor replay an older list.
import { describe, expect, it } from "vitest";
import { snapshotBody } from "./authority/state.js";
import { generateEd25519Signer } from "./crypto.js";
import { assessFreshness } from "./freshness/freshness.js";
import { formatEd25519PublicKey } from "./keys.js";
import { signStatement } from "./statements/envelope.js";
import type { ServerBindingBody } from "./statements/types.js";
import { parseStatement } from "./statements/validate.js";
import { buildWorld, WORLD_HOST, WORLD_NOW } from "./testing/world.js";
import { selectVersion } from "./version.js";

describe("selectVersion", () => {
  it("picks the highest shared version and names which side is behind", () => {
    expect(selectVersion([1, 2, 3], [1, 2])).toEqual({ ok: true, version: 2 });
    expect(selectVersion([2], [1, 2, 3])).toEqual({ ok: true, version: 2 });
    expect(selectVersion([3, 4], [1, 2])).toEqual({ ok: false, code: "update_required" });
    expect(selectVersion([1], [2, 3])).toEqual({ ok: false, code: "gateway_outdated" });
  });
});

describe("advertised versions in the snapshot", () => {
  it("are signed by K_gw and reach the client only on fresh evidence", async () => {
    const world = await buildWorld();
    const kgw = await generateEd25519Signer();
    const binding: ServerBindingBody = {
      claw_id: world.state.claw_id,
      hostname: WORLD_HOST,
      k_srv: "iroh:".concat("ab".repeat(32)) as ServerBindingBody["k_srv"],
      k_gw: formatEd25519PublicKey(kgw.publicKey),
      binding_seq: 1,
      root_epoch: 1,
      issued_at: WORLD_NOW,
    };
    const body = snapshotBody(world.state, 1, WORLD_NOW);
    expect(body.protocols).toEqual({ statement: [1], descriptor: [1] });
    const snapshot = await signStatement("MembershipSnapshot", body, kgw);
    const ctx = { binding, stored: null, now: WORLD_NOW, policy: "enforce" as const };

    const fresh = await assessFreshness({ snapshot }, ctx);
    expect(fresh.verdict).toMatchObject({ ok: true, fresh: true, protocols: body.protocols });

    // Discovery edits the list (to add or drop a version): the K_gw signature no
    // longer verifies, so no list reaches the client.
    const edited = {
      ...snapshot,
      body: { ...body, protocols: { statement: [1, 2], descriptor: [1] } },
    };
    expect((await assessFreshness({ snapshot: edited }, ctx)).verdict).toMatchObject({
      ok: false,
      code: "freshness_unavailable",
    });

    // Replaying an older list fails freshness once a newer snapshot was seen.
    const newer = await signStatement(
      "MembershipSnapshot",
      { ...body, issued_at: WORLD_NOW + 60 },
      kgw,
    );
    const seen = (await assessFreshness({ snapshot: newer }, { ...ctx, now: WORLD_NOW + 60 }))
      .state;
    expect(
      (await assessFreshness({ snapshot }, { ...ctx, stored: seen, now: WORLD_NOW + 60 })).verdict,
    ).toMatchObject({ ok: false, code: "freshness_unavailable" });
  });

  it("must be a non-empty ascending list of versions", async () => {
    const world = await buildWorld();
    const kgw = await generateEd25519Signer();
    const body = snapshotBody(world.state, 1, WORLD_NOW);
    const snapshot = await signStatement("MembershipSnapshot", body, kgw);
    for (const statement of [[], [2, 1], [1, 1], [0], [1.5], ["1"]]) {
      const raw = { ...snapshot, body: { ...body, protocols: { ...body.protocols, statement } } };
      expect(parseStatement(raw, "MembershipSnapshot")).toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
  });
});
