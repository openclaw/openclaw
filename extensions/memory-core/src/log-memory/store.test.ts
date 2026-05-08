import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogMemoryStore } from "./store.js";
import { makeTempWorkspace } from "./test-helpers.js";
import type { LogMemoryEntry } from "./types.js";

function entry(opts: {
  id?: string;
  ts: Date;
  content: string;
  tags?: string[];
  decay?: number;
  accessCount?: number;
}): LogMemoryEntry {
  return {
    id: opts.id ?? "x",
    timestamp: opts.ts,
    layer: "episodic",
    payload: {
      type: "raw_log",
      content: opts.content,
      tags: opts.tags ?? ["level:ERROR", "service:diagfw"],
      source: "log_ingest",
      decayScore: opts.decay ?? 0.95,
      accessCount: opts.accessCount ?? 0,
      lastAccessedAt: opts.ts,
    },
  };
}

describe("LogMemoryStore (file-based)", () => {
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("appends episodic blocks to the day-keyed file", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "probe failed" }));
    const filePath = store.episodicPathFor(ts);
    const text = await fs.readFile(filePath, "utf8");
    expect(text).toContain("## [2026-05-07T12:00:00.000Z]");
    expect(text).toContain("probe failed");
    expect(text).toContain("decay:");
    expect(text).toContain("accessCount: 0");
  });

  it("loads episodic entries via parseBlocks", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "first" }));
    await store.appendEpisodic(entry({ ts: new Date(ts.getTime() + 60_000), content: "second" }));
    const loaded = await store.loadEpisodic();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].payload.content).toBe("first");
    expect(loaded[1].payload.content).toBe("second");
  });

  it("appends semantic blocks to KNOWLEDGE.md", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendSemantic({
      id: "k1",
      timestamp: ts,
      layer: "semantic",
      payload: {
        type: "engineer_knowledge",
        content: "humidity matters",
        tags: ["service:cooler"],
        source: "engineer_teach",
        decayScore: 0.95,
        accessCount: 0,
        lastAccessedAt: ts,
        title: "humidity",
      },
    });
    const text = await fs.readFile(store.semanticPath(), "utf8");
    expect(text).toContain("## [2026-05-07T12:00:00.000Z] humidity");
    expect(text).toContain("Source: engineer_teach");
  });

  it("countByLayer reads from the files", async () => {
    const ts = new Date();
    await store.appendEpisodic(entry({ ts, content: "a" }));
    await store.appendEpisodic(entry({ ts: new Date(ts.getTime() + 1), content: "b" }));
    expect(await store.countByLayer("episodic")).toBe(2);
    expect(await store.countByLayer("semantic")).toBe(0);
  });

  it("removeEpisodic deletes specified entries and rewrites the file", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "keep me" }));
    await store.appendEpisodic(entry({ ts: new Date(ts.getTime() + 60_000), content: "drop me" }));
    const before = await store.loadEpisodic();
    const targetId = before.find((e) => e.payload.content === "drop me")!.id;

    const removed = await store.removeEpisodic([targetId]);
    expect(removed).toBe(1);
    const after = await store.loadEpisodic();
    expect(after).toHaveLength(1);
    expect(after[0].payload.content).toBe("keep me");
  });

  it("removeEpisodic deletes the day file when emptied", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "only" }));
    const onlyId = (await store.loadEpisodic())[0].id;
    await store.removeEpisodic([onlyId]);
    const filePath = store.episodicPathFor(ts);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("recordAccess bumps accessCount and persists", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "ping" }));
    const id = (await store.loadEpisodic())[0].id;
    const updated = await store.recordAccess(id, new Date(ts.getTime() + 60_000));
    expect(updated).toBe(true);
    const after = await store.loadEpisodic();
    expect(after[0].payload.accessCount).toBe(1);
  });

  it("selectDreamCandidates filters by current dynamic decay", async () => {
    const oldTs = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    await store.appendEpisodic(entry({ ts: oldTs, content: "ancient", decay: 0.05 }));
    await store.appendEpisodic(entry({ ts: new Date(), content: "fresh", decay: 1 }));
    const candidates = await store.selectDreamCandidates({
      threshold: 0.25,
      limit: 100,
      now: new Date(),
    });
    expect(candidates.map((c) => c.payload.content)).toEqual(["ancient"]);
  });

  it("markConsolidated flags entries non-destructively and is hidden by default", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "old probe failure" }));
    await store.appendEpisodic(
      entry({ ts: new Date(ts.getTime() + 60_000), content: "fresh probe failure" }),
    );
    const before = await store.loadEpisodic();
    expect(before).toHaveLength(2);
    const targetId = before[0].id;

    const at = new Date("2026-05-08T03:00:00Z");
    const marked = await store.markConsolidated([targetId], at);
    expect(marked).toBe(1);

    // Default reads skip the consolidated entry.
    const visible = await store.loadEpisodic();
    expect(visible).toHaveLength(1);
    expect(visible[0].id).not.toBe(targetId);
    expect(await store.countByLayer("episodic")).toBe(1);

    // Raw block still on disk — opt-in to see it.
    const raw = await store.loadEpisodic({ includeConsolidated: true });
    expect(raw).toHaveLength(2);
    const consolidated = raw.find((e) => e.id === targetId);
    expect(consolidated?.payload.consolidatedAt?.toISOString()).toBe(at.toISOString());

    // The day file was rewritten in place — no fs.rm.
    const filePath = store.episodicPathFor(ts);
    const text = await fs.readFile(filePath, "utf8");
    expect(text).toContain("consolidatedAt: 2026-05-08T03:00:00.000Z");
    expect(text).toContain("old probe failure");
    expect(text).toContain("fresh probe failure");
  });

  it("markConsolidated is a no-op for already-consolidated ids", async () => {
    const ts = new Date("2026-05-07T12:00:00Z");
    await store.appendEpisodic(entry({ ts, content: "x" }));
    const id = (await store.loadEpisodic())[0].id;
    const at = new Date(ts.getTime() + 60_000);
    expect(await store.markConsolidated([id], at)).toBe(1);
    expect(await store.markConsolidated([id], new Date(at.getTime() + 60_000))).toBe(0);
  });

  it("selectDreamCandidates excludes already-consolidated entries", async () => {
    const oldTs = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    await store.appendEpisodic(entry({ ts: oldTs, content: "ancient", decay: 0.05 }));
    const id = (await store.loadEpisodic())[0].id;
    let candidates = await store.selectDreamCandidates({
      threshold: 0.25,
      limit: 100,
      now: new Date(),
    });
    expect(candidates).toHaveLength(1);
    await store.markConsolidated([id], new Date());
    candidates = await store.selectDreamCandidates({
      threshold: 0.25,
      limit: 100,
      now: new Date(),
    });
    expect(candidates).toHaveLength(0);
  });

  it("loadEpisodic respects daysBack", async () => {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    await store.appendEpisodic(entry({ ts: today, content: "today" }));
    await store.appendEpisodic(entry({ ts: threeDaysAgo, content: "old" }));
    const recent = await store.loadEpisodic({ daysBack: 1 });
    expect(recent.map((e) => e.payload.content)).toEqual(["today"]);
    const all = await store.loadEpisodic();
    expect(all).toHaveLength(2);
  });
});
