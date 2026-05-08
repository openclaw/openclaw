import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogIngestor } from "./ingestor.js";
import { LogMemoryStore } from "./store.js";
import { makeFakeEmbedder, makeTempWorkspace } from "./test-helpers.js";

describe("LogIngestor (file-backed)", () => {
  const embed = makeFakeEmbedder(8);
  let workspace: ReturnType<typeof makeTempWorkspace>;
  let store: LogMemoryStore;

  beforeEach(() => {
    workspace = makeTempWorkspace();
    store = new LogMemoryStore({ workspaceDir: workspace.dir });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it("parses, tags, and appends to the day-keyed file", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const result = await ingestor.ingest("2026-05-07T12:00:00Z ERROR diagfw probe disconnected", {
      service: "diagfw",
      host: "dut-01",
    });
    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0].payload.tags).toEqual(
      expect.arrayContaining(["level:ERROR", "host:dut-01", "service:diagfw"]),
    );
    const text = await fs.readFile(store.episodicPathFor(new Date("2026-05-07T12:00:00Z")), "utf8");
    expect(text).toContain("probe disconnected");
  });

  it("dedupes identical logs across calls", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const line = "2026-05-07T12:00:00Z ERROR diagfw probe disconnected";
    const meta = { service: "diagfw", host: "dut-01" };
    await ingestor.ingest(line, meta);
    const second = await ingestor.ingest(line, meta);
    expect(second.inserted).toHaveLength(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(await store.countByLayer("episodic")).toBe(1);
  });

  it("chunks long messages with overlap", async () => {
    const ingestor = new LogIngestor({ store, embed });
    const long = `2026-05-07T12:00:00Z ERROR diagfw ${Array.from({ length: 800 }, (_, i) => `t${i}`).join(" ")}`;
    const result = await ingestor.ingest(long, { service: "diagfw", host: "dut-01" });
    expect(result.inserted.length).toBeGreaterThan(1);
  });

  it("fires the threshold trigger and reports it", async () => {
    const trigger = vi.fn();
    // Pre-populate to push count past the configured threshold.
    for (let i = 0; i < 5; i++) {
      const ingestor = new LogIngestor({ store, embed });
      await ingestor.ingest(`2026-05-07T12:00:0${i}Z INFO diagfw warmup ${i}`, {
        service: "diagfw",
        host: "dut-01",
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

  it("hybrid query returns scored results and bumps accessCount", async () => {
    const ingestor = new LogIngestor({ store, embed });
    await ingestor.ingest("2026-05-07T12:00:00Z ERROR diagfw broken sensor on dut-01", {
      service: "diagfw",
      host: "dut-01",
    });
    await ingestor.ingest("2026-05-07T12:01:00Z INFO diagfw routine heartbeat ok", {
      service: "diagfw",
      host: "dut-01",
    });

    const results = await ingestor.query("broken sensor");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.payload.content).toContain("broken sensor");
    expect(results[0].score).toBeCloseTo(
      0.6 * results[0].vectorScore + 0.4 * results[0].bm25Score,
      6,
    );

    const after = await store.loadEpisodic();
    const matched = after.find((entry) => entry.payload.content.includes("broken sensor"));
    expect(matched?.payload.accessCount).toBe(1);
  });
});
