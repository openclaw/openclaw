import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryRef, memoryLocationId } from "../ref.js";
import { upsertRecord } from "../sidecar-repo.js";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import { loadSidecarSignalsByLocations } from "./lookup.js";

const refFor = (path: string, startLine = 1, endLine = 5): MemoryRef => ({
  source: "memory",
  path,
  startLine,
  endLine,
  contentHash: `${path}-h`,
});

const locFor = (path: string, startLine = 1, endLine = 5) =>
  memoryLocationId({ source: "memory", path, startLine, endLine });

describe("loadSidecarSignalsByLocations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty map for empty input", () => {
    expect(loadSidecarSignalsByLocations(db, []).size).toBe(0);
  });

  it("returns rows keyed by location_id", () => {
    upsertRecord(db, refFor("a.md"), { salience: 0.7, pinned: true }, 1000);
    upsertRecord(db, refFor("b.md"), { salience: 0.3, pinned: false }, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md"), locFor("b.md")]);
    expect(out.size).toBe(2);
    expect(out.get(locFor("a.md"))?.salience).toBe(0.7);
    expect(out.get(locFor("a.md"))?.pinned).toBe(true);
    expect(out.get(locFor("b.md"))?.salience).toBe(0.3);
  });

  it("omits unknown locations rather than throwing", () => {
    upsertRecord(db, refFor("a.md"), { salience: 0.5 }, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md"), locFor("missing.md")]);
    expect(out.has(locFor("a.md"))).toBe(true);
    expect(out.has(locFor("missing.md"))).toBe(false);
  });

  it("status defaults to active when sidecar row was inserted via upsert", () => {
    upsertRecord(db, refFor("a.md"), {}, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md")]);
    expect(out.get(locFor("a.md"))?.status).toBe("active");
  });

  it("propagates status='superseded'", () => {
    upsertRecord(db, refFor("a.md"), { status: "superseded" }, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md")]);
    expect(out.get(locFor("a.md"))?.status).toBe("superseded");
  });

  it("prefers the higher-salience row when two share a location_id", () => {
    // Two distinct refs for the same (source, path, lines) — different content
    // hashes produce different ref_ids but identical location_ids.
    upsertRecord(db, { ...refFor("a.md"), contentHash: "h1" }, { salience: 0.2 }, 1000);
    upsertRecord(db, { ...refFor("a.md"), contentHash: "h2" }, { salience: 0.8 }, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md")]);
    expect(out.get(locFor("a.md"))?.salience).toBe(0.8);
  });

  it("handles single-element queries", () => {
    upsertRecord(db, refFor("a.md"), { salience: 0.4 }, 1000);
    const out = loadSidecarSignalsByLocations(db, [locFor("a.md")]);
    expect(out.size).toBe(1);
  });
});
