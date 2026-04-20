import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTER_DEFAULTS } from "./config.js";
import { ROUTING_LOG_FILENAME, toLogEntry, writeEntry } from "./logger.js";
import { resolve } from "./resolver.js";

describe("aj-router logger", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aj-router-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a log entry from a successful resolver result", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "Classify this email as spam.",
    });
    const entry = toLogEntry(result, { promptLength: 30 });
    expect(entry.rejected).toBe(false);
    expect(entry.alias).toBe("speed");
    expect(entry.modelRef).toBe("anthropic/claude-haiku-4-5");
    expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("builds a log entry from a rejection", () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "Classify this email as spam.",
      sensitivity: "privileged",
    });
    const entry = toLogEntry(result, { promptLength: 30 });
    expect(entry.rejected).toBe(true);
    expect(entry.rejectionReason).toContain("blocks external providers");
  });

  it("appends a JSONL row to <logsDir>/routing.jsonl", async () => {
    const result = resolve({
      config: ROUTER_DEFAULTS,
      prompt: "hello world",
    });
    const entry = toLogEntry(result, { promptLength: 11 });
    await writeEntry({ logsDir: dir, entry });
    await writeEntry({ logsDir: dir, entry });
    const text = await readFile(join(dir, ROUTING_LOG_FILENAME), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = lines[0];
    expect(first).toBeDefined();
    expect(JSON.parse(first ?? "{}").alias).toBeTypeOf("string");
  });
});
