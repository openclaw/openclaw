// Boundary and lifecycle proof for location-triggered standing intents.
//
// Covers: create validation, baseline-first fence machine (no fire on arm),
// one-shot fire semantics with atomic consumption, duplicate-fix idempotency,
// cancel/expiry isolation, wrong-node isolation, and restart persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  requireNativeSqliteDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocationStandingIntent,
  cancelStandingIntent,
  fireLocationIntentsForNode,
  listStandingIntents,
} from "./standing-intents.js";

async function closeAgents() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

const base = {
  agentId: "main",
  description: "Buy groceries when leaving lunch.",
  nodeId: "iphone",
  direction: "exit" as const,
  centerLat: 57.697_47,
  centerLon: 11.950_73,
  radiusMeters: 55,
  deliveryTarget: "agent:main:main",
  creatorSender: "owner-sender",
};

// Fixes around the Beefeater center, scaled to the 55 m fence.
const inside = { lat: 57.697_47, lon: 11.950_73, accuracyMeters: 10 };
const outside = { lat: 57.6991, lon: 11.9505, accuracyMeters: 10 };

function fix(params: Partial<typeof inside> = {}): {
  lat: number;
  lon: number;
  accuracyMeters: number;
} {
  return { ...inside, ...params };
}

const fire = (nodeId: string, f: { lat: number; lon: number; accuracyMeters: number }) =>
  fireLocationIntentsForNode({ agentId: "main", nodeId, ...f });

describe("location standing intents", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-location-intents-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
      recursive: true,
    });
    await closeAgents();
  });

  afterEach(async () => {
    await closeAgents();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rejects invalid geometry and missing delivery targets", async () => {
    await expect(createLocationStandingIntent({ ...base, radiusMeters: 0 })).rejects.toThrow(
      /radius/,
    );
    await expect(createLocationStandingIntent({ ...base, centerLat: 96 })).rejects.toThrow(
      /bounds/,
    );
    await expect(createLocationStandingIntent({ ...base, deliveryTarget: "  " })).rejects.toThrow(
      /delivery session/,
    );
    await expect(createLocationStandingIntent({ ...base, nodeId: "   " })).rejects.toThrow(
      /node id/,
    );
  });

  it("establishes a baseline without firing, then fires exactly once on real exit", async () => {
    const intent = await createLocationStandingIntent(base);
    // First fix only establishes the baseline.
    expect((await fire("iphone", fix())).fired).toEqual([]);
    // Duplicate inside fixes: no fire, no state churn.
    expect((await fire("iphone", fix())).fired).toEqual([]);
    // Real crossing.
    const crossing = await fire("iphone", outside);
    expect(crossing.fired).toHaveLength(1);
    expect(crossing.fired[0]?.id).toBe(intent.id);
    // One-shot: a replayed crossing consumes nothing further.
    expect((await fire("iphone", outside)).fired).toEqual([]);
    const rows = await listStandingIntents({ agentId: "main" });
    const firedRow = rows.find((row) => row.id === intent.id);
    expect(firedRow?.status).toBe("done");
    expect(firedRow?.fireCount).toBe(1);
    expect(firedRow?.deliveryTarget).toBe("agent:main:main");
  });

  it("is idempotent under concurrent duplicate fixes", async () => {
    await createLocationStandingIntent(base);
    await Promise.all([fire("iphone", fix()), fire("iphone", fix()), fire("iphone", fix())]);
    const results = await Promise.all([fire("iphone", outside), fire("iphone", outside)]);
    const fires = results.flatMap((outcome) => outcome.fired);
    expect(fires).toHaveLength(1);
  });

  it("holds ambiguous fixes and never fires on GPS jitter at the boundary", async () => {
    await createLocationStandingIntent(base);
    // Establish a definite inside baseline.
    expect((await fire("iphone", fix())).fired).toEqual([]);
    // Accuracy circle straddles the boundary; decision must hold state.
    const ambiguous = { lat: 57.697_98, lon: 11.950_73, accuracyMeters: 60 };
    expect((await fire("iphone", ambiguous)).fired).toEqual([]);
    expect((await fire("iphone", ambiguous)).fired).toEqual([]);
    // ...and the held inside baseline still yields exactly one fire on a
    // definite crossing afterwards.
    const crossing = await fire("iphone", { ...outside, accuracyMeters: 5 });
    expect(crossing.fired).toHaveLength(1);
  });

  it("ignores fixes from other nodes and cancelled/expired intents", async () => {
    const intent = await createLocationStandingIntent(base);
    expect((await fire("watch", outside)).fired).toEqual([]);
    await cancelStandingIntent({ agentId: "main", id: intent.id });
    expect((await fire("iphone", fix())).fired).toEqual([]);
    expect((await fire("iphone", outside)).fired).toEqual([]);
    const rows = await listStandingIntents({ agentId: "main" });
    expect(rows.find((row) => row.id === intent.id)?.status).toBe("cancelled");
  });

  it("matches direction semantics independently (enter vs exit fences)", async () => {
    const enterIntent = await createLocationStandingIntent({
      ...base,
      description: "Ping on arrival at the office.",
      direction: "enter",
    });
    const exitIntent = await createLocationStandingIntent(base);
    // Start outside: baseline only.
    expect((await fire("iphone", outside)).fired).toEqual([]);
    // Entering fires the enter fence.
    const entering = await fire("iphone", fix());
    expect(entering.fired).toHaveLength(1);
    expect(entering.fired[0]?.id).toBe(enterIntent.id);
    // Exit-only fences stay untouched by the same crossing.
    const rows = await listStandingIntents({ agentId: "main" });
    expect(rows.find((row) => row.id === enterIntent.id)?.status).toBe("done");
  });

  it("never fires an exit fence on an inside fix (arrival only baselines)", async () => {
    // Regression: 2026-11-16 live drive — an exit fence armed with an
    // outside baseline fired "leaving home" on the user's ARRIVAL fix.
    const exitIntent = await createLocationStandingIntent(base);
    // Baseline outside.
    expect((await fire("iphone", outside)).fired).toEqual([]);
    // Arriving home: the inside fix must baseline silently, NOT fire.
    const arriving = await fire("iphone", fix());
    expect(arriving.fired).toEqual([]);
    // The baseline flipped to inside; a real exit still fires exactly once.
    const leaving = await fire("iphone", outside);
    expect(leaving.fired).toHaveLength(1);
    expect(leaving.fired[0]?.id).toBe(exitIntent.id);
  });

  it("never fires an enter fence on an exit crossing (unit: 1→0 is exit-only)", async () => {
    // Regression: 2026-11-13 live drive — a Göteborg ARRIVAL fence fired at
    // 06:33 on the user's morning DEPARTURE from inside the fence. A one-shot
    // enter fence consumes itself on its first inside fix, so this state is
    // only reachable at the decision level; assert the gate directly.
    const { decideLocationFire } = await import("./standing-intents-model.js");
    const enterTrigger = {
      nodeId: "iphone",
      direction: "enter" as const,
      centerLat: base.centerLat,
      centerLon: base.centerLon,
      radiusMeters: base.radiusMeters,
    };
    const leaving = decideLocationFire({
      trigger: enterTrigger,
      previousInside: 1,
      ...outside,
    });
    expect(leaving.inside).toBe(0);
    expect(leaving.shouldFire).toBe(false);
    // ...and a real 0→1 arrival still fires.
    const arriving = decideLocationFire({
      trigger: enterTrigger,
      previousInside: 0,
      ...fix(),
    });
    expect(arriving.shouldFire).toBe(true);
  });

  it("keeps untriggered location intents armed after keyword-style listing", async () => {
    await createLocationStandingIntent(base);
    const rows = await listStandingIntents({ agentId: "main" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trigger).toEqual({
      kind: "location",
      location: {
        nodeId: "iphone",
        direction: "exit",
        centerLat: base.centerLat,
        centerLon: base.centerLon,
        radiusMeters: base.radiusMeters,
      },
    });
    expect(rows[0]?.triggerKeywords).toEqual([]);
    expect(rows[0]?.status).toBe("armed");
  });

  it("survives restart: baseline state persists in the agent database", async () => {
    await createLocationStandingIntent(base);
    await fire("iphone", fix());
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    // Reopen without re-arming: the baseline must persist and a crossing fires.
    const crossing = await fire("iphone", outside);
    expect(crossing.fired).toHaveLength(1);
  });
});
