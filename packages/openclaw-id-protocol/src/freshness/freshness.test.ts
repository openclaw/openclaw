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
  isOlderSnapshot,
  knownRevocations,
  SNAPSHOT_MAX_AGE_SECONDS,
  SNAPSHOT_REPUBLISH_SECONDS,
  type FreshnessEvidence,
  type FreshnessPolicy,
  type RevocationState,
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
  const binding = (seq: number, k_srv: IrohEndpointKey, issued_at = now - 10) =>
    signStatement(
      "ServerBinding",
      { claw_id, hostname: HOST, k_srv, k_gw, binding_seq: seq, root_epoch: 1, issued_at },
      root,
    );
  const snapshot = (
    seq: number,
    binding_seq: number,
    opts: { revoked?: string[]; issued_at?: number; signer?: StatementSigner } = {},
  ) =>
    signStatement(
      "MembershipSnapshot",
      {
        claw_id,
        seq,
        binding_seq,
        owner_peer_keys: [],
        members: [],
        revoked: (opts.revoked ?? []) as never,
        issued_at: opts.issued_at ?? now - 60,
      },
      opts.signer ?? kgw,
    );
  const revocation = async (target: string, signer: StatementSigner = root) =>
    signStatement(
      "Revocation",
      {
        target_fp: await fingerprint(target as IrohEndpointKey),
        target_kind: "server_key",
        reason: "retired",
        root_epoch: 1,
        issued_at: now - 30,
      },
      signer,
    );
  const pin: ClawPin = {
    claw_id,
    root_fp: await fingerprint(root_pub),
    root_epoch: 1,
    binding_seq: 4,
  };
  return { root_pub, claw_id, oldSrv, newSrv, binding, snapshot, revocation, pin };
}
type World = Awaited<ReturnType<typeof world>>;

// The client sequence: pin check, then freshness, then the re-check with the merged set.
async function gate(
  w: World,
  binding: SignedStatement<"ServerBinding">,
  evidence: FreshnessEvidence,
  {
    stored = null,
    policy = "enforce",
  }: { stored?: RevocationState | null; policy?: FreshnessPolicy } = {},
) {
  const known = knownRevocations(stored, w.claw_id);
  const pinEvidence = { root_pub: w.root_pub, rotations: [], binding };
  const first = await verifyBindingForPin(pinEvidence, w.pin, {
    host: HOST,
    now,
    isRevoked: (fp) => known.has(fp),
  });
  if (!first.ok) {
    return { ok: false, code: first.code, state: stored };
  }
  const a = await assessFreshness(evidence, {
    binding: first.binding,
    anchor: first.anchor,
    stored,
    now,
    policy,
  });
  if (a.learned.length > 0) {
    const merged = new Set(a.state.revoked);
    const again = await verifyBindingForPin(pinEvidence, w.pin, {
      host: HOST,
      now,
      isRevoked: (fp) => merged.has(fp),
    });
    if (!again.ok) {
      return { ok: false, code: again.code, state: a.state };
    }
  }
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
  it("refuses a year-old binding at the pinned seq once the Gateway signed a newer one", async () => {
    const w = await world();
    const old = await w.binding(4, w.oldSrv, now - YEAR);
    const r = await gate(w, old, { snapshot: await w.snapshot(9, 5), revocations: null });
    expect([r.ok, r.code]).toEqual([false, "stale_binding"]);
  });

  it("passes the current binding with a fresh snapshot and records the marker", async () => {
    const w = await world();
    const r = await gate(w, await w.binding(5, w.newSrv), {
      snapshot: await w.snapshot(9, 5),
      revocations: [],
    });
    expect(r).toMatchObject({ ok: true, fresh: true });
    expect(r.state?.snapshot).toEqual({ seq: 9, issued_at: now - 60, binding_seq: 5 });
  });

  it("enforce refuses withheld freshness; report dials and names the gap", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const cases: [FreshnessEvidence, string][] = [
      [{ snapshot: null, revocations: null }, "snapshot_missing"],
      [
        {
          snapshot: await w.snapshot(9, 4, { issued_at: now - SNAPSHOT_MAX_AGE_SECONDS - 1 }),
          revocations: null,
        },
        "snapshot_stale",
      ],
      [
        { snapshot: await w.snapshot(9, 4, { issued_at: now + 3600 }), revocations: null },
        "snapshot_future",
      ],
      [
        {
          snapshot: await w.snapshot(9, 4, { signer: await generateEd25519Signer() }),
          revocations: null,
        },
        "snapshot_invalid",
      ],
      [{ snapshot: { type: "MembershipSnapshot" }, revocations: null }, "snapshot_invalid"],
      [{ snapshot: await w.snapshot(9, 3), revocations: null }, "snapshot_lagging"],
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
      revocations: null,
    });
    const resigned = await gate(
      w,
      b,
      { snapshot: await w.snapshot(9, 4, { issued_at: now - 5 }), revocations: null },
      { stored: first.state },
    );
    expect(resigned).toMatchObject({ ok: true, fresh: true });
    expect(resigned.state?.snapshot?.issued_at).toBe(now - 5);
    const replay = await gate(
      w,
      b,
      {
        snapshot: await w.snapshot(9, 4, { issued_at: now - SNAPSHOT_REPUBLISH_SECONDS }),
        revocations: null,
      },
      { stored: resigned.state, policy: "report" },
    );
    expect(replay.gap).toBe("snapshot_replayed");
  });

  it("enforces revocations from the snapshot or owner-signed under either policy, and keeps them", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const fromSnapshot = await gate(
      w,
      b,
      {
        snapshot: await w.snapshot(9, 4, { revoked: [await fingerprint(w.oldSrv)] }),
        revocations: null,
      },
      { policy: "report" },
    );
    expect([fromSnapshot.ok, fromSnapshot.code]).toEqual([false, "server_key_revoked"]);
    const fromOwner = await gate(
      w,
      b,
      { snapshot: null, revocations: [await w.revocation(w.oldSrv)] },
      { policy: "report" },
    );
    expect([fromOwner.ok, fromOwner.code]).toEqual([false, "server_key_revoked"]);
    const later = await gate(
      w,
      b,
      { snapshot: null, revocations: null },
      { stored: fromOwner.state, policy: "report" },
    );
    expect([later.ok, later.code]).toEqual([false, "server_key_revoked"]);
  });

  it("ignores revocations not signed under the pinned anchor", async () => {
    const w = await world();
    const stranger = await deriveRootSigner(generateKitSecret());
    const r = await gate(w, await w.binding(5, w.newSrv), {
      snapshot: await w.snapshot(9, 5),
      revocations: [await w.revocation(w.newSrv, stranger), { junk: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.state?.revoked).toEqual([]);
  });

  it("refuses a revoked K_gw, and a stored marker keeps refusing an older binding", async () => {
    const w = await world();
    const b5 = await w.binding(5, w.newSrv);
    const first = await gate(w, b5, { snapshot: await w.snapshot(9, 5), revocations: null });
    const replay = await gate(
      w,
      await w.binding(4, w.oldSrv),
      { snapshot: null, revocations: null },
      { stored: first.state, policy: "report" },
    );
    expect([replay.ok, replay.code]).toEqual([false, "stale_binding"]);
    const kgwRevoked = { ...first.state!, revoked: [await fingerprint(b5.body.k_gw)] };
    const r = await gate(
      w,
      b5,
      { snapshot: await w.snapshot(10, 5), revocations: null },
      { stored: kgwRevoked },
    );
    expect([r.ok, r.code]).toEqual([false, "server_key_revoked"]);
  });

  it("never stores a snapshot from the future", async () => {
    const w = await world();
    const b = await w.binding(4, w.oldSrv);
    const future = await gate(
      w,
      b,
      { snapshot: await w.snapshot(99, 4, { issued_at: now + 30 * 86400 }), revocations: null },
      { policy: "report" },
    );
    expect(future.gap).toBe("snapshot_future");
    expect(future.state?.snapshot).toBeNull();
    const honest = await gate(
      w,
      b,
      { snapshot: await w.snapshot(9, 4), revocations: null },
      { stored: future.state },
    );
    expect(honest.ok).toBe(true);
  });

  it("ignores stored state of another claw", async () => {
    const w = await world();
    const r = await gate(
      w,
      await w.binding(5, w.newSrv),
      { snapshot: await w.snapshot(9, 5), revocations: null },
      {
        stored: {
          claw_id: "f".repeat(32),
          revoked: [await fingerprint(w.newSrv)],
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
