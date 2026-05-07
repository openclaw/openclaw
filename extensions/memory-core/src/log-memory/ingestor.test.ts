import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogIngestor } from "./ingestor.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";

describe("LogIngestor", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    store.close();
    workspace.cleanup();
  });

  it("parses, embeds, and stores a single log line", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const result = await ingestor.ingest("2026-05-07T12:00:00Z ERROR diagfw probe disconnected", {
      service: "diagfw",
      host: "dut-01",
    });
    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0].payload.tags).toEqual(
      expect.arrayContaining(["level:ERROR", "host:dut-01", "service:diagfw"]),
    );
    expect(store.countByLayer("episodic")).toBe(1);
  });

  it("dedupes identical logs", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const line = "2026-05-07T12:00:00Z ERROR diagfw probe disconnected";
    const meta = { service: "diagfw", host: "dut-01" };
    await ingestor.ingest(line, meta);
    const second = await ingestor.ingest(line, meta);
    expect(second.inserted).toHaveLength(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(store.countByLayer("episodic")).toBe(1);
  });

  it("chunks long messages with overlap", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const long = `2026-05-07T12:00:00Z ERROR diagfw ${Array.from({ length: 800 }, (_, i) => `t${i}`).join(" ")}`;
    const result = await ingestor.ingest(long, { service: "diagfw", host: "dut-01" });
    expect(result.inserted.length).toBeGreaterThan(1);
  });

  it("fires threshold trigger and returns triggeredDream=true", async () => {
    const trigger = vi.fn();
    // Pre-populate to push count past the configured threshold.
    for (let i = 0; i < 5; i++) {
      const [vec] = await embed([`pre-${i}`]);
      store.upsert({
        id: `pre-${i}`,
        timestamp: new Date(Date.now() - i * 1000),
        layer: "episodic",
        embedding: vec,
        payload: {
          type: "raw_log",
          content: `pre-${i}`,
          tags: [],
          source: "log_ingest",
          decayScore: 1,
          accessCount: 0,
          lastAccessedAt: new Date(),
        },
      });
    }
    const ingestor = new LogIngestor({
      store,
      embed,
      dreamThreshold: 4,
      onThresholdTrigger: trigger,
    });
    const result = await ingestor.ingest("2026-05-07T13:00:00Z ERROR diagfw new probe failure", {
      service: "diagfw",
      host: "dut-01",
    });
    expect(result.triggeredDream).toBe(true);
    expect(trigger).toHaveBeenCalledWith("threshold");
  });

  it("query records access counts on retrieved entries", async () => {
    const ingestor = new LogIngestor({ store, embed });
    await ingestor.ingest("2026-05-07T12:00:00Z ERROR diagfw broken sensor", {
      service: "diagfw",
      host: "dut-01",
    });
    const before = store.listByLayer("episodic")[0];
    expect(before.payload.accessCount).toBe(0);
    const results = await ingestor.query("broken sensor");
    expect(results.length).toBeGreaterThan(0);
    const after = store.listByLayer("episodic")[0];
    expect(after.payload.accessCount).toBe(1);
  });
});
