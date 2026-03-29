import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryTracer } from "./tracer.js";

describe("MemoryTracer", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memory-hybrid-tracer-"));
    logFile = join(tmpDir, "thoughts.jsonl");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write structured JSON lines to the log file", async () => {
    const tracer = new MemoryTracer({ customPath: logFile });

    tracer.trace("test_action", { foo: "bar" }, "Test user thought");
    await tracer.flush();

    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.action).toBe("test_action");
    expect(parsed.details.foo).toBe("bar");
    expect(parsed.message).toBe("Test user thought");
    expect(parsed.timestamp).toBeDefined();
  });
});
