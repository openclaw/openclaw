import { describe, expect, it } from "vitest";
import { bytesToHex } from "../bytes.js";
import { generateEd25519Signer, randomBytes, type StatementSigner } from "../crypto.js";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  type IrohEndpointKey,
} from "../keys.js";
import { deriveRootSigner, generateKitSecret } from "../kit.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin, type ClawPin } from "../statements/pin.js";
import type { SignedStatement } from "../statements/types.js";
import {
  assessFreshness,
  clampFreshnessState,
  isOlderSnapshot,
  SNAPSHOT_MAX_AGE_SECONDS,
  SNAPSHOT_REPUBLISH_SECONDS,
  type FreshnessEvidence,
  type FreshnessPolicy,
  type FreshnessState,
} from "./freshness.js";

const HOST = "studio-k7x2q.example.test";
const now = Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400;

// One claw: owner R, K_gw, and two generations of K_srv (binding_seq 4 retired, 5 current).
async function world() {
  const root = await deriveRootSigner(generateKitSecret());
  const root_pub = formatEd25519PublicKey(root.publicKey);
  const kgw = await generateEd25519Signer();
  const claw_id = bytesToHex(randomBytes(16));
  const oldSrv = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const newSrv = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const k_gw = formatEd25519PublicKey(kgw.publicKey);
  const binding = (
    seq: number,
    k_srv: IrohEndpointKey,
    issued_at = now - 10,
    gateway: StatementSigner = kgw,
  ) =>
    signStatement(
      "ServerBinding",
      {
        claw_id,
        hostname: HOST,
        k_srv,
        k_gw: formatEd25519PublicKey(gateway.publicKey),
        binding_seq: seq,
        root_epoch: 1,
        issued_at,
      },
      root,
    );
  const snapshot = (
    seq: number,
    binding_seq: number,
    opts: { issued_at?: number; signer?: StatementSigner } = {},
  ) =>
    signStatement(
      "MembershipSnapshot",
      {
        claw_id,
        seq,
        binding_seq,
        owner_devices: [],
        owner_peer_keys: [],
        node_peer_keys: [],
        members: [],
        protocols: { statement: [1], descriptor: [1] },
        issued_at: opts.issued_at ?? now - 60,
      },
      opts.signer ?? kgw,
    );
  const pin: ClawPin = {
    claw_id,
    root_fp: await fingerprint(root_pub),
    binding_seq: 4,
  };
  return { root_pub, claw_id, oldSrv, newSrv, binding, snapshot, pin, kgw, k_gw };
}
type World = Awaited<ReturnType<typeof world>>;

// The client sequence: pin check, then freshness.
async function gate(
  w: World,
  binding: SignedStatement<"ServerBinding">,
  evidence: FreshnessEvidence,
  {
    stored = null,
    policy = "enforce",
  }: { stored?: FreshnessState | null; policy?: FreshnessPolicy } = {},
) {
  const pinEvidence = { root_pub: w.root_pub, binding };
  const first = await verifyBindingForPin(pinEvidence, w.pin, { host: HOST, now });
  if (!first.ok) {
    return { ok: false, code: first.code, state: stored };
  }
  const a = await assessFreshness(evidence, { binding: first.binding, stored, now, policy });
  return a.verdict.ok
    ? {
        ok: true,
        fresh: a.verdict.fresh,
        gap: a.verdict.fresh ? undefined : a.verdict.gap,
        state: a.state,
      }
    : { ok: false, code: a.verdict.code, state: a.state };
}

describe("assessFreshness", () => {
  it("refuses a year-old binding once the client verified a newer one", async () => {
    const w = await world();
    const current = await gate(w, await w.binding(5, w.newSrv), {
      snapshot: await w.snapshot(9, 5),
    });
    const old = await w.binding(4, w.oldSrv, now - YEAR);
    const r = await gate(w, old, { snapshot: await w.snapshot(9, 4) }, { stored: current.state });
    expect([r.ok, r.code]).toEqual([false, "stale_binding"]);
  });

  it("refuses a snapshot naming a binding beyond the verified one and keeps nothing of it (J5)", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const honest = await gate(w, b, { snapshot: await w.snapshot(9, 4) });
    // A stolen K_gw signs a snapshot claiming binding 99.
    const inflated = await gate(
      w,
      b,
      { snapshot: await w.snapshot(10, 99) },
      { stored: honest.state, policy: "report" },
    );
    expect([inflated.ok, inflated.code]).toEqual([false, "snapshot_ahead"]);
    expect(inflated.state).toEqual(honest.state);
    // The honest binding still dials afterwards.
    const again = await gate(
      w,
      b,
      { snapshot: await w.snapshot(10, 4) },
      { stored: inflated.state },
    );
    expect(again).toMatchObject({ ok: true, fresh: true });
  });

  it("passes the current binding with a fresh snapshot and records the marker", async () => {
    const w = await world();
    const r = await gate(w, await w.binding(5, w.newSrv), {
      snapshot: await w.snapshot(9, 5),
    });
    expect(r).toMatchObject({ ok: true, fresh: true });
    expect(r.state?.snapshot).toEqual({
      seq: 9,
      issued_at: now - 60,
      binding_seq: 5,
      k_gw: w.k_gw,
    });
  });

  it("enforce refuses withheld freshness; report dials and names the gap", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const cases: [FreshnessEvidence, string][] = [
      [{ snapshot: null }, "snapshot_missing"],
      [
        {
          snapshot: await w.snapshot(9, 4, { issued_at: now - SNAPSHOT_MAX_AGE_SECONDS - 1 }),
        },
        "snapshot_stale",
      ],
      [{ snapshot: await w.snapshot(9, 4, { issued_at: now + 3600 }) }, "snapshot_future"],
      [
        {
          snapshot: await w.snapshot(9, 4, { signer: await generateEd25519Signer() }),
        },
        "snapshot_invalid",
      ],
      [{ snapshot: { type: "MembershipSnapshot" } }, "snapshot_invalid"],
      [{ snapshot: await w.snapshot(9, 3) }, "snapshot_lagging"],
    ];
    for (const [evidence, gap] of cases) {
      const enforced = await gate(w, b, evidence);
      expect([enforced.ok, enforced.code], gap).toEqual([false, "freshness_unavailable"]);
      const reported = await gate(w, b, evidence, { policy: "report" });
      expect([reported.ok, reported.fresh, reported.gap]).toEqual([true, false, gap]);
    }
  });

  it("accepts the hourly same-seq re-sign and refuses an older issued_at after it", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const first = await gate(w, b, {
      snapshot: await w.snapshot(9, 4, { issued_at: now - SNAPSHOT_REPUBLISH_SECONDS }),
    });
    const resigned = await gate(
      w,
      b,
      { snapshot: await w.snapshot(9, 4, { issued_at: now - 5 }) },
      { stored: first.state },
    );
    expect(resigned).toMatchObject({ ok: true, fresh: true });
    expect(resigned.state?.snapshot?.issued_at).toBe(now - 5);
    const replay = await gate(
      w,
      b,
      {
        snapshot: await w.snapshot(9, 4, { issued_at: now - SNAPSHOT_REPUBLISH_SECONDS }),
      },
      { stored: resigned.state, policy: "report" },
    );
    expect(replay.gap).toBe("snapshot_replayed");
  });

  it("a stored marker keeps refusing an older binding", async () => {
    const w = await world();
    const b5 = await w.binding(5, w.newSrv);
    const first = await gate(w, b5, { snapshot: await w.snapshot(9, 5) });
    const replay = await gate(
      w,
      await w.binding(4, w.oldSrv),
      { snapshot: null },
      { stored: first.state, policy: "report" },
    );
    expect([replay.ok, replay.code]).toEqual([false, "stale_binding"]);
  });

  it("retains binding retirement and membership order independently across refused evidence", async () => {
    const w = await world();
    const old = await w.binding(4, w.oldSrv);
    const first = await gate(w, await w.binding(5, w.newSrv), { snapshot: await w.snapshot(9, 5) });
    const inconsistent = await gate(
      w,
      old,
      { snapshot: await w.snapshot(10, 4) },
      { stored: first.state },
    );
    expect(inconsistent).toMatchObject({ ok: false, code: "stale_binding" });
    expect(inconsistent.state?.snapshot).toEqual({
      seq: 10,
      issued_at: now - 60,
      binding_seq: 5,
      k_gw: w.k_gw,
    });
    const replay = await gate(
      w,
      old,
      { snapshot: await w.snapshot(10, 4) },
      { stored: inconsistent.state },
    );
    expect(replay).toMatchObject({ ok: false, code: "stale_binding" });
    const current = await w.binding(5, w.newSrv);
    const membershipReplay = await gate(
      w,
      current,
      { snapshot: await w.snapshot(9, 5) },
      { stored: inconsistent.state },
    );
    expect(membershipReplay).toMatchObject({ ok: false, code: "freshness_unavailable" });
  });

  it("restarts snapshot order at a re-bind to a new K_gw and keeps the binding high-water", async () => {
    const w = await world();
    const old = await w.binding(4, w.oldSrv);
    // Whoever held the retired K_gw signed far ahead before the re-bind.
    const inflated = await gate(w, old, { snapshot: await w.snapshot(1_000, 4) });
    expect(inflated).toMatchObject({ ok: true, fresh: true });
    const kgw2 = await generateEd25519Signer();
    const rebound = await w.binding(5, w.newSrv, now - 10, kgw2);
    const honest = await gate(
      w,
      rebound,
      { snapshot: await w.snapshot(9, 5, { signer: kgw2 }) },
      { stored: inflated.state },
    );
    expect(honest).toMatchObject({ ok: true, fresh: true });
    expect(honest.state?.snapshot).toEqual({
      seq: 9,
      issued_at: now - 60,
      binding_seq: 5,
      k_gw: formatEd25519PublicKey(kgw2.publicKey),
    });
    // Ordered among the new K_gw's snapshots from here.
    const replay = await gate(
      w,
      rebound,
      { snapshot: await w.snapshot(8, 5, { signer: kgw2 }) },
      { stored: honest.state, policy: "report" },
    );
    expect(replay.gap).toBe("snapshot_replayed");
    // The retired binding and its key's snapshots stay refused.
    const retired = await gate(
      w,
      old,
      { snapshot: await w.snapshot(2_000, 4) },
      { stored: honest.state },
    );
    expect(retired).toMatchObject({ ok: false, code: "stale_binding" });
    expect(retired.state?.snapshot?.k_gw).toBe(formatEd25519PublicKey(kgw2.publicKey));
  });

  it("a retired key's snapshot claiming the next binding cannot hold the new key's order", async () => {
    const w = await world();
    const old = await w.binding(4, w.oldSrv);
    // The old K_gw claims binding 5 before the owner re-binds: refused, but the high-water is kept.
    const claim = await gate(w, old, { snapshot: await w.snapshot(1_000, 5) });
    expect(claim).toMatchObject({ ok: false, code: "snapshot_ahead" });
    expect(claim.state?.snapshot).toBeNull();
    const kgw2 = await generateEd25519Signer();
    const rebound = await w.binding(5, w.newSrv, now - 10, kgw2);
    const first = await gate(
      w,
      rebound,
      { snapshot: await w.snapshot(9, 5, { signer: kgw2, issued_at: now - 120 }) },
      { stored: claim.state },
    );
    const newer = await gate(
      w,
      rebound,
      { snapshot: await w.snapshot(10, 5, { signer: kgw2 }) },
      { stored: first.state },
    );
    expect(newer).toMatchObject({ ok: true, fresh: true });
    expect(newer.state?.snapshot).toMatchObject({
      seq: 10,
      k_gw: formatEd25519PublicKey(kgw2.publicKey),
    });
    // Discovery replays the new key's older snapshot.
    const replay = await gate(
      w,
      rebound,
      { snapshot: await w.snapshot(9, 5, { signer: kgw2, issued_at: now - 120 }) },
      { stored: newer.state, policy: "report" },
    );
    expect(replay.gap).toBe("snapshot_replayed");
  });

  it("caps a stored high-water a snapshot raised before the rule at the verified binding", async () => {
    const stored = { claw_id: "c", snapshot: { seq: 3, issued_at: 1, binding_seq: 99 } };
    expect(clampFreshnessState(stored, 4)).toEqual({
      claw_id: "c",
      snapshot: { seq: 3, issued_at: 1, binding_seq: 4 },
    });
    expect(clampFreshnessState(stored, 120)).toBe(stored);
    expect(clampFreshnessState(null, 4)).toBeNull();
  });

  it("never stores a snapshot from the future", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const future = await gate(
      w,
      b,
      { snapshot: await w.snapshot(99, 4, { issued_at: now + 30 * 86400 }) },
      { policy: "report" },
    );
    expect(future.gap).toBe("snapshot_future");
    expect(future.state?.snapshot).toBeNull();
    const honest = await gate(w, b, { snapshot: await w.snapshot(9, 4) }, { stored: future.state });
    expect(honest.ok).toBe(true);
  });

  it("ignores stored state of another claw", async () => {
    const w = await world();
    const r = await gate(
      w,
      await w.binding(5, w.newSrv),
      { snapshot: await w.snapshot(9, 5) },
      {
        stored: {
          claw_id: "f".repeat(32),
          snapshot: { seq: 99, issued_at: now, binding_seq: 99 },
        },
      },
    );
    expect(r.ok).toBe(true);
  });
});

describe("isOlderSnapshot", () => {
  it("orders by seq, then issued_at", () => {
    expect(isOlderSnapshot({ seq: 1, issued_at: 9 }, { seq: 2, issued_at: 1 })).toBe(true);
    expect(isOlderSnapshot({ seq: 2, issued_at: 1 }, { seq: 2, issued_at: 2 })).toBe(true);
    expect(isOlderSnapshot({ seq: 2, issued_at: 2 }, { seq: 2, issued_at: 2 })).toBe(false);
    expect(isOlderSnapshot({ seq: 3, issued_at: 1 }, { seq: 2, issued_at: 9 })).toBe(false);
  });
});
