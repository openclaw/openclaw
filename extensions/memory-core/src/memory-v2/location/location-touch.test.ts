import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLocationId } from "../ref.js";
import { upsertRecord } from "../sidecar-repo.js";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import { type TouchableHit, recordTouchedLocations } from "./location-touch.js";

const hit = (overrides: Partial<TouchableHit> = {}): TouchableHit => ({
  source: "memory",
  path: "memory/2026-04-15.md",
  startLine: 10,
  endLine: 24,
  ...overrides,
});

describe("recordTouchedLocations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns a zero outcome on empty input", () => {
    expect(recordTouchedLocations(db, [], 1000)).toEqual({
      inspected: 0,
      inserted: 0,
      refreshed: 0,
    });
  });

  it("inserts a stub row for a previously-unseen location", () => {
    const out = recordTouchedLocations(db, [hit()], 1000);
    expect(out).toEqual({ inspected: 1, inserted: 1, refreshed: 0 });
    const row = db
      .prepare(
        `SELECT source_kind, status, pinned, last_accessed_at, location_id, content_hash
           FROM memory_v2_records`,
      )
      .get() as {
      source_kind: string;
      status: string;
      pinned: number;
      last_accessed_at: number;
      location_id: string;
      content_hash: string;
    };
    expect(row.source_kind).toBe("indexed");
    expect(row.status).toBe("active");
    expect(row.pinned).toBe(0);
    expect(row.last_accessed_at).toBe(1000);
    expect(row.location_id).toBe(memoryLocationId(hit()));
    expect(row.content_hash).toBe("");
  });

  it("refreshes last_accessed_at for an existing location and does not duplicate", () => {
    recordTouchedLocations(db, [hit()], 1000);
    const out = recordTouchedLocations(db, [hit()], 2000);
    expect(out).toEqual({ inspected: 1, inserted: 0, refreshed: 1 });
    const rows = db.prepare(`SELECT last_accessed_at FROM memory_v2_records`).all() as Array<{
      last_accessed_at: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.last_accessed_at).toBe(2000);
  });

  it("refreshes a row that was inserted by ingest (different ref_id, same location)", () => {
    upsertRecord(
      db,
      {
        source: "memory",
        path: "memory/2026-04-15.md",
        startLine: 10,
        endLine: 24,
        contentHash: "real-content-hash",
      },
      { memoryType: "preference", importance: 0.6, salience: 0.6, confidence: 0.6 },
      500,
    );
    const out = recordTouchedLocations(db, [hit()], 2000);
    expect(out).toEqual({ inspected: 1, inserted: 0, refreshed: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM memory_v2_records`).get() as { n: number },
    ).toEqual({ n: 1 });
    const row = db.prepare(`SELECT last_accessed_at, memory_type FROM memory_v2_records`).get() as {
      last_accessed_at: number;
      memory_type: string | null;
    };
    expect(row.last_accessed_at).toBe(2000);
    expect(row.memory_type).toBe("preference");
  });

  it("partitions by source so memory and sessions paths do not collide", () => {
    recordTouchedLocations(db, [hit({ source: "memory" })], 1000);
    const out = recordTouchedLocations(db, [hit({ source: "sessions" })], 1000);
    expect(out.inserted).toBe(1);
    const rows = db.prepare(`SELECT source FROM memory_v2_records ORDER BY source`).all() as Array<{
      source: string;
    }>;
    expect(rows.map((r) => r.source)).toEqual(["memory", "sessions"]);
  });

  it("inserts one row per distinct location across a batch", () => {
    const out = recordTouchedLocations(
      db,
      [
        hit({ path: "memory/a.md" }),
        hit({ path: "memory/b.md" }),
        hit({ path: "memory/a.md" }), // dup of first within batch — refresh on second pass
      ],
      1000,
    );
    expect(out.inserted).toBe(2);
    expect(out.refreshed).toBe(1);
  });
});
