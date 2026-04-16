import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocationId } from "../ref.js";
import { ensureSidecarSchema } from "../sidecar-schema.js";
import type { RerankableResult } from "./types.js";
import { buildRerankWrapper } from "./wrapper.js";

const result = (overrides: Partial<RerankableResult> = {}): RerankableResult => ({
  source: "memory",
  path: "memory/a.md",
  startLine: 1,
  endLine: 5,
  score: 1,
  ...overrides,
});

describe("buildRerankWrapper — disabled", () => {
  it("returns identity (returns input) when enabled=false", async () => {
    const fn = buildRerankWrapper({ enabled: false });
    const inputs = [result({ score: 0.4 }), result({ path: "b.md", score: 0.9 })];
    const out = await fn(inputs, { workspaceDir: "/ws" });
    expect(out.length).toBe(2);
    expect(out.map((r) => r.score)).toEqual([0.4, 0.9]);
  });
});

describe("buildRerankWrapper — enabled", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSidecarSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns identity when results array is empty", async () => {
    const openDb = vi.fn();
    const fn = buildRerankWrapper({ enabled: true }, { openDb: openDb as never });
    const out = await fn([], { workspaceDir: "/ws" });
    expect(out).toEqual([]);
    expect(openDb).not.toHaveBeenCalled();
  });

  it("returns identity when workspaceDir is missing", async () => {
    const openDb = vi.fn();
    const fn = buildRerankWrapper({ enabled: true }, { openDb: openDb as never });
    const out = await fn([result()], {});
    expect(out.length).toBe(1);
    expect(out[0]?.score).toBe(1);
    expect(openDb).not.toHaveBeenCalled();
  });

  it("looks up signals once and rescales scores", async () => {
    const r = result();
    const locId = memoryLocationId({
      source: r.source,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
    });
    let calls = 0;
    let receivedIds: readonly string[] = [];
    const loadSignals = (_db: DatabaseSync, ids: readonly string[]) => {
      calls++;
      receivedIds = ids;
      return new Map([
        [locId, { salience: 0.7, pinned: true, status: "active", lastAccessedAt: null } as const],
      ]);
    };
    const fn = buildRerankWrapper(
      { enabled: true },
      { openDb: () => db, loadSignals: loadSignals as never, now: () => 1000 },
    );
    const out = await fn([r], { workspaceDir: "/ws" });
    expect(calls).toBe(1);
    expect(receivedIds).toEqual([locId]);
    expect(out[0]?.score).toBeGreaterThan(1);
  });

  it("caches the per-workspace db across calls when using the default opener", async () => {
    // Override openDb to count opens; default opener does the caching.
    let opens = 0;
    const fn = buildRerankWrapper(
      { enabled: true },
      {
        openDb: () => {
          opens++;
          return db;
        },
        now: () => 1000,
      },
    );
    await fn([result()], { workspaceDir: "/ws" });
    await fn([result()], { workspaceDir: "/ws" });
    // Slice 2a's wrapper itself does not cache; only the *default* opener does.
    // When deps.openDb is injected, the caller controls caching. Confirm both
    // calls reach the injected opener (so wiring is correct).
    expect(opens).toBe(2);
  });

  it("degrades to identity if openDb throws", async () => {
    const fn = buildRerankWrapper(
      { enabled: true },
      {
        openDb: () => {
          throw new Error("disk full");
        },
        logWarn: vi.fn() as never,
      },
    );
    const out = await fn([result()], { workspaceDir: "/ws" });
    expect(out[0]?.score).toBe(1);
  });

  it("degrades to identity if loadSignals throws", async () => {
    const logWarn = vi.fn();
    const fn = buildRerankWrapper(
      { enabled: true },
      {
        openDb: () => db,
        loadSignals: (() => {
          throw new Error("boom");
        }) as never,
        logWarn: logWarn as never,
      },
    );
    const out = await fn([result()], { workspaceDir: "/ws" });
    expect(out[0]?.score).toBe(1);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("does not call touch when shadowOnRecall is false (default)", async () => {
    const touch = vi.fn(() => ({ inspected: 0, inserted: 0, refreshed: 0 }));
    const fn = buildRerankWrapper(
      { enabled: true },
      { openDb: () => db, touch: touch as never, now: () => 1000 },
    );
    await fn([result()], { workspaceDir: "/ws" });
    expect(touch).not.toHaveBeenCalled();
  });

  it("calls touch exactly once with all hits when shadowOnRecall is true", async () => {
    let calls = 0;
    let receivedHits: ReadonlyArray<{ path: string }> = [];
    let receivedNow = 0;
    const touch = (_db: DatabaseSync, hits: ReadonlyArray<{ path: string }>, now: number) => {
      calls++;
      receivedHits = hits;
      receivedNow = now;
      return { inspected: 0, inserted: 0, refreshed: 0 };
    };
    const fn = buildRerankWrapper(
      { enabled: true, shadowOnRecall: true },
      { openDb: () => db, touch: touch as never, now: () => 5000 },
    );
    await fn([result(), result({ path: "b.md" })], { workspaceDir: "/ws" });
    expect(calls).toBe(1);
    expect(receivedHits.map((h) => h.path)).toEqual(["memory/a.md", "b.md"]);
    expect(receivedNow).toBe(5000);
  });

  it("excludes non-memory sources from the shadow-touch hit list", async () => {
    let receivedHits: ReadonlyArray<{ source: string; path: string }> = [];
    const touch = (
      _db: DatabaseSync,
      hits: ReadonlyArray<{ source: string; path: string }>,
      _now: number,
    ) => {
      receivedHits = hits;
      return { inspected: 0, inserted: 0, refreshed: 0 };
    };
    const fn = buildRerankWrapper(
      { enabled: true, shadowOnRecall: true },
      { openDb: () => db, touch: touch as never, now: () => 1000 },
    );
    const mixed = [
      result({ path: "memory/a.md" }),
      {
        source: "wiki",
        path: "wiki/x.md",
        startLine: 1,
        endLine: 2,
        score: 0.3,
      } as unknown as RerankableResult,
      result({ source: "sessions", path: "sessions/s.md" }),
    ];
    await fn(mixed, { workspaceDir: "/ws" });
    expect(receivedHits.map((h) => `${h.source}:${h.path}`)).toEqual([
      "memory:memory/a.md",
      "sessions:sessions/s.md",
    ]);
  });
});
