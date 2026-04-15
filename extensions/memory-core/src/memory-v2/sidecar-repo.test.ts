import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryRef, memoryRefId } from "./ref.js";
import {
  deleteByRefId,
  getByRefId,
  listByRefIds,
  markStatus,
  setPinned,
  touchLastAccessed,
  upsertRecord,
} from "./sidecar-repo.js";
import { ensureSidecarSchema } from "./sidecar-schema.js";

const refA: MemoryRef = {
  source: "memory",
  path: "memory/a.md",
  startLine: 1,
  endLine: 5,
  contentHash: "h-a",
};
const refB: MemoryRef = {
  source: "memory",
  path: "memory/b.md",
  startLine: 1,
  endLine: 5,
  contentHash: "h-b",
};

describe("sidecar repo", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a new record with defaults when none exists", () => {
    const rec = upsertRecord(db, refA, {}, 1000);
    expect(rec.refId).toBe(memoryRefId(refA));
    expect(rec.status).toBe("active");
    expect(rec.pinned).toBe(false);
    expect(rec.createdAt).toBe(1000);
    expect(rec.lastAccessedAt).toBeNull();
    expect(rec.schemaVersion).toBe(1);
  });

  it("upsert preserves created_at and updates only provided fields", () => {
    upsertRecord(db, refA, { importance: 0.5, salience: 0.2 }, 1000);
    const updated = upsertRecord(db, refA, { salience: 0.9 }, 2000);
    expect(updated.createdAt).toBe(1000);
    expect(updated.importance).toBe(0.5);
    expect(updated.salience).toBe(0.9);
  });

  it("upsert can explicitly null a field by passing null", () => {
    upsertRecord(db, refA, { memoryType: "preference" }, 1000);
    const cleared = upsertRecord(db, refA, { memoryType: null }, 1500);
    expect(cleared.memoryType).toBeNull();
  });

  it("getByRefId returns null for unknown ids", () => {
    expect(getByRefId(db, "deadbeef")).toBeNull();
  });

  it("listByRefIds returns only matched rows and tolerates missing ids", () => {
    upsertRecord(db, refA, {}, 1000);
    upsertRecord(db, refB, {}, 1000);
    const idA = memoryRefId(refA);
    const idB = memoryRefId(refB);
    const rows = listByRefIds(db, [idA, "missing", idB]);
    const ids = rows.map((r) => r.refId).toSorted();
    expect(ids).toEqual([idA, idB].toSorted());
  });

  it("listByRefIds short-circuits on empty input", () => {
    expect(listByRefIds(db, [])).toEqual([]);
  });

  it("markStatus updates and reports change", () => {
    upsertRecord(db, refA, {}, 1000);
    expect(markStatus(db, memoryRefId(refA), "superseded")).toBe(true);
    expect(getByRefId(db, memoryRefId(refA))?.status).toBe("superseded");
    expect(markStatus(db, "missing", "archived")).toBe(false);
  });

  it("setPinned toggles pinned flag", () => {
    upsertRecord(db, refA, {}, 1000);
    expect(setPinned(db, memoryRefId(refA), true)).toBe(true);
    expect(getByRefId(db, memoryRefId(refA))?.pinned).toBe(true);
    expect(setPinned(db, memoryRefId(refA), false)).toBe(true);
    expect(getByRefId(db, memoryRefId(refA))?.pinned).toBe(false);
  });

  it("touchLastAccessed sets timestamp without disturbing other fields", () => {
    upsertRecord(db, refA, { importance: 0.7 }, 1000);
    expect(touchLastAccessed(db, memoryRefId(refA), 9999)).toBe(true);
    const rec = getByRefId(db, memoryRefId(refA));
    expect(rec?.lastAccessedAt).toBe(9999);
    expect(rec?.importance).toBe(0.7);
    expect(rec?.createdAt).toBe(1000);
  });

  it("deleteByRefId removes the row", () => {
    upsertRecord(db, refA, {}, 1000);
    expect(deleteByRefId(db, memoryRefId(refA))).toBe(true);
    expect(getByRefId(db, memoryRefId(refA))).toBeNull();
    expect(deleteByRefId(db, memoryRefId(refA))).toBe(false);
  });
});
