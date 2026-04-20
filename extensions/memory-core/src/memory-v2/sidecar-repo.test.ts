import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryRef, memoryLocationId, memoryRefId } from "./ref.js";
import {
  deleteByRefId,
  getByRefId,
  listByRefIds,
  markStatus,
  REF_ID_AMBIGUOUS_CANDIDATE_CAP,
  resolveRefIdByPrefix,
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

  it("derives location_id from the ref on insert", () => {
    const rec = upsertRecord(db, refA, {}, 1000);
    expect(rec.locationId).toBe(
      memoryLocationId({
        source: refA.source,
        path: refA.path,
        startLine: refA.startLine,
        endLine: refA.endLine,
      }),
    );
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

describe("resolveRefIdByPrefix", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // Seeds a row whose ref id is exactly `refId` by stuffing the literal id
  // into the table. Cheaper than going through memoryRefId when the test
  // wants to control the id text (e.g. shared prefixes, LIKE metachars).
  const insertRowWithRefId = (refId: string) => {
    db.prepare(
      `INSERT INTO memory_v2_records (
         ref_id, source, path, start_line, end_line, content_hash,
         status, pinned, created_at, schema_version
       ) VALUES (?, 'memory', 'memory/x.md', 1, 1, '', 'active', 0, 1, 1)`,
    ).run(refId);
  };

  it("returns match with the canonical id for an exact full-id lookup", () => {
    insertRowWithRefId("refs:abc123def456");

    expect(resolveRefIdByPrefix(db, "refs:abc123def456")).toEqual({
      kind: "match",
      refId: "refs:abc123def456",
    });
  });

  it("returns match for a unique prefix and resolves to the full id", () => {
    insertRowWithRefId("refs:abc123def456");

    expect(resolveRefIdByPrefix(db, "refs:abc")).toEqual({
      kind: "match",
      refId: "refs:abc123def456",
    });
    expect(resolveRefIdByPrefix(db, "refs:abc1")).toEqual({
      kind: "match",
      refId: "refs:abc123def456",
    });
  });

  it("trims surrounding whitespace before matching", () => {
    insertRowWithRefId("refs:abc123def456");

    expect(resolveRefIdByPrefix(db, "  refs:abc  ")).toEqual({
      kind: "match",
      refId: "refs:abc123def456",
    });
  });

  it("reports ambiguous with the sorted candidate list when multiple rows share the prefix", () => {
    insertRowWithRefId("refs:abc-one");
    insertRowWithRefId("refs:abc-two");
    insertRowWithRefId("refs:zz-other");

    const resolution = resolveRefIdByPrefix(db, "refs:abc");

    expect(resolution).toEqual({
      kind: "ambiguous",
      input: "refs:abc",
      candidates: ["refs:abc-one", "refs:abc-two"],
      hasMore: false,
    });
  });

  it("caps the ambiguous candidate list and flags hasMore when there are more matches", () => {
    const total = REF_ID_AMBIGUOUS_CANDIDATE_CAP + 2;
    for (let i = 0; i < total; i++) {
      insertRowWithRefId(`refs:abc-${i.toString().padStart(2, "0")}`);
    }

    const resolution = resolveRefIdByPrefix(db, "refs:abc");

    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") {
      return;
    }
    expect(resolution.candidates).toHaveLength(REF_ID_AMBIGUOUS_CANDIDATE_CAP);
    expect(resolution.hasMore).toBe(true);
    expect(resolution.candidates[0]).toBe("refs:abc-00");
  });

  it("reports miss when nothing matches the prefix", () => {
    insertRowWithRefId("refs:abc");

    expect(resolveRefIdByPrefix(db, "refs:nope")).toEqual({
      kind: "miss",
      input: "refs:nope",
    });
  });

  it("reports miss for empty or whitespace-only input without matching every row", () => {
    insertRowWithRefId("refs:abc");
    insertRowWithRefId("refs:xyz");

    expect(resolveRefIdByPrefix(db, "")).toEqual({ kind: "miss", input: "" });
    expect(resolveRefIdByPrefix(db, "   ")).toEqual({ kind: "miss", input: "" });
  });

  it("escapes LIKE metacharacters so literal `_` and `%` in the input are not wildcards", () => {
    // Without escaping, LIKE 'a_%%' would match both of these rows via the
    // `_` and `%` wildcards. With escaping, only the literal-underscore row
    // should match when the caller asks for `a_`.
    insertRowWithRefId("a_literal");
    insertRowWithRefId("axliteral");

    const resolution = resolveRefIdByPrefix(db, "a_");
    expect(resolution).toEqual({ kind: "match", refId: "a_literal" });

    insertRowWithRefId("a%percent");
    insertRowWithRefId("aXpercent");

    // `a%` would match everything without escaping; with escaping, only the
    // literal-percent row should resolve.
    const resolution2 = resolveRefIdByPrefix(db, "a%");
    expect(resolution2).toEqual({ kind: "match", refId: "a%percent" });
  });
});
