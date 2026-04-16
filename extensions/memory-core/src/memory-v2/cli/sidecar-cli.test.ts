import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryRefId } from "../ref.js";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import {
  DEFAULT_LIST_LIMIT,
  formatPinLine,
  readSidecarList,
  readSidecarStats,
  writeSidecarPin,
} from "./sidecar-cli.js";

type InsertRow = {
  source: "memory" | "sessions";
  path: string;
  startLine: number;
  endLine: number;
  status: "active" | "superseded" | "archived" | "deleted";
  pinned: boolean;
  salience: number | null;
  createdAt: number;
  lastAccessedAt: number | null;
};

function insertRow(db: DatabaseSync, row: InsertRow): void {
  const refId = memoryRefId({
    source: row.source,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    contentHash: `${row.path}:${row.createdAt}`,
  });
  db.prepare(
    `INSERT INTO memory_v2_records (
       ref_id, source, path, start_line, end_line, content_hash,
       status, pinned, salience, created_at, last_accessed_at, schema_version
     ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1)`,
  ).run(
    refId,
    row.source,
    row.path,
    row.startLine,
    row.endLine,
    row.status,
    row.pinned ? 1 : 0,
    row.salience,
    row.createdAt,
    row.lastAccessedAt,
  );
}

describe("readSidecarStats", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zeros and null bounds for an empty sidecar", () => {
    const stats = readSidecarStats(db);
    expect(stats.total).toBe(0);
    expect(stats.pinned).toBe(0);
    expect(stats.byStatus).toEqual({});
    expect(stats.bySource).toEqual({});
    expect(stats.schemaVersion).toBe(1);
    expect(stats.oldestCreatedAt).toBeNull();
    expect(stats.newestCreatedAt).toBeNull();
    expect(stats.newestAccessedAt).toBeNull();
  });

  it("aggregates counts by status and source and surfaces time bounds", () => {
    insertRow(db, {
      source: "memory",
      path: "memory/a.md",
      startLine: 1,
      endLine: 5,
      status: "active",
      pinned: true,
      salience: 0.7,
      createdAt: 1000,
      lastAccessedAt: 1500,
    });
    insertRow(db, {
      source: "memory",
      path: "memory/b.md",
      startLine: 1,
      endLine: 3,
      status: "superseded",
      pinned: false,
      salience: null,
      createdAt: 2000,
      lastAccessedAt: null,
    });
    insertRow(db, {
      source: "sessions",
      path: "sessions/c.md",
      startLine: 1,
      endLine: 2,
      status: "active",
      pinned: false,
      salience: 0.3,
      createdAt: 3000,
      lastAccessedAt: 2500,
    });

    const stats = readSidecarStats(db);
    expect(stats.total).toBe(3);
    expect(stats.pinned).toBe(1);
    expect(stats.byStatus).toEqual({ active: 2, superseded: 1 });
    expect(stats.bySource).toEqual({ memory: 2, sessions: 1 });
    expect(stats.oldestCreatedAt).toBe(1000);
    expect(stats.newestCreatedAt).toBe(3000);
    expect(stats.newestAccessedAt).toBe(2500);
  });
});

describe("readSidecarList", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns rows newest-first and applies the limit", () => {
    for (let i = 0; i < 5; i++) {
      insertRow(db, {
        source: "memory",
        path: `memory/r${i}.md`,
        startLine: 1,
        endLine: 2,
        status: "active",
        pinned: false,
        salience: null,
        createdAt: 1000 + i,
        lastAccessedAt: null,
      });
    }
    const rows = readSidecarList(db, { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.path)).toEqual(["memory/r4.md", "memory/r3.md", "memory/r2.md"]);
  });

  it("filters by status when supplied", () => {
    insertRow(db, {
      source: "memory",
      path: "memory/a.md",
      startLine: 1,
      endLine: 2,
      status: "active",
      pinned: false,
      salience: null,
      createdAt: 1000,
      lastAccessedAt: null,
    });
    insertRow(db, {
      source: "memory",
      path: "memory/b.md",
      startLine: 1,
      endLine: 2,
      status: "superseded",
      pinned: false,
      salience: null,
      createdAt: 2000,
      lastAccessedAt: null,
    });
    const rows = readSidecarList(db, { status: "superseded" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("memory/b.md");
    expect(rows[0]?.status).toBe("superseded");
  });

  it("defaults to the documented limit when none is given", () => {
    for (let i = 0; i < DEFAULT_LIST_LIMIT + 5; i++) {
      insertRow(db, {
        source: "memory",
        path: `memory/r${i}.md`,
        startLine: 1,
        endLine: 2,
        status: "active",
        pinned: false,
        salience: null,
        createdAt: 1000 + i,
        lastAccessedAt: null,
      });
    }
    const rows = readSidecarList(db);
    expect(rows).toHaveLength(DEFAULT_LIST_LIMIT);
  });
});

describe("writeSidecarPin", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  const seededRefId = (): string =>
    memoryRefId({
      source: "memory",
      path: "memory/a.md",
      startLine: 1,
      endLine: 5,
      contentHash: "memory/a.md:1000",
    });

  const seedUnpinned = () => {
    insertRow(db, {
      source: "memory",
      path: "memory/a.md",
      startLine: 1,
      endLine: 5,
      status: "active",
      pinned: false,
      salience: null,
      createdAt: 1000,
      lastAccessedAt: null,
    });
  };

  const seedPinned = () => {
    insertRow(db, {
      source: "memory",
      path: "memory/a.md",
      startLine: 1,
      endLine: 5,
      status: "active",
      pinned: true,
      salience: null,
      createdAt: 1000,
      lastAccessedAt: null,
    });
  };

  it("flips pinned to true on an existing row and reports found=true", () => {
    seedUnpinned();
    const refId = seededRefId();

    const outcome = writeSidecarPin(db, refId, true);

    expect(outcome).toEqual({ refId, found: true, pinned: true });
    const row = db.prepare("SELECT pinned FROM memory_v2_records WHERE ref_id = ?").get(refId) as {
      pinned: number;
    };
    expect(row.pinned).toBe(1);
  });

  it("flips pinned to false on an existing pinned row (unpin path)", () => {
    seedPinned();
    const refId = seededRefId();

    const outcome = writeSidecarPin(db, refId, false);

    expect(outcome).toEqual({ refId, found: true, pinned: false });
    const row = db.prepare("SELECT pinned FROM memory_v2_records WHERE ref_id = ?").get(refId) as {
      pinned: number;
    };
    expect(row.pinned).toBe(0);
  });

  it("reports found=false without throwing or inserting when the ref id is unknown", () => {
    const outcome = writeSidecarPin(db, "refs:memory:does-not-exist:0-0:abc", true);

    expect(outcome.found).toBe(false);
    expect(outcome.refId).toBe("refs:memory:does-not-exist:0-0:abc");

    const total = db.prepare("SELECT COUNT(*) AS n FROM memory_v2_records").get() as { n: number };
    expect(total.n).toBe(0);
  });

  it("produces a stable JSON shape (refId, found, pinned) for --json callers", () => {
    seedUnpinned();
    const refId = seededRefId();

    const outcome = writeSidecarPin(db, refId, true);

    expect(Object.keys(outcome).toSorted()).toEqual(["found", "pinned", "refId"]);
    expect(JSON.parse(JSON.stringify(outcome))).toEqual({
      refId,
      found: true,
      pinned: true,
    });
  });
});

describe("formatPinLine", () => {
  it("renders pinned/unpinned/not-found lines from the outcome", () => {
    expect(formatPinLine({ refId: "refs:abc", found: true, pinned: true })).toBe("pinned refs:abc");
    expect(formatPinLine({ refId: "refs:abc", found: true, pinned: false })).toBe(
      "unpinned refs:abc",
    );
    expect(formatPinLine({ refId: "refs:missing", found: false, pinned: true })).toBe(
      "ref-id not found: refs:missing",
    );
  });
});
