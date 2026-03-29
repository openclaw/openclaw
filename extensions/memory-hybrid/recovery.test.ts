import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { WorkingMemoryBuffer } from "./buffer.js";
import { GraphDB } from "./graph.js";
import { MemoryTracer } from "./tracer.js";

describe("Recovery & Corruption Handling", () => {
  const baseDir = join(tmpdir(), `memory-recovery-${Date.now()}`);
  const dbPath = join(baseDir, "lancedb");
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  const tracer = new MemoryTracer();

  beforeEach(async () => {
    await mkdir(dbPath, { recursive: true });
  });

  test("Handling Corrupt Working Memory JSONL", async () => {
    const buffer = new WorkingMemoryBuffer();
    const filePath = join(dbPath, "working_memory.jsonl");
    await writeFile(filePath, "{ invalid json ...", "utf-8");
    await expect(buffer.load(filePath, logger)).resolves.toBe(false);
    expect(buffer.size).toBe(0);
  });

  test("Handling Corrupt Graph DB JSON", async () => {
    const graph = new GraphDB(dbPath, tracer, logger);
    const filePath = join(baseDir, "graph.json");
    await writeFile(filePath, "NOT A JSON OBJECT", "utf-8");
    await expect(graph.load()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
