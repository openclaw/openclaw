import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextLifecycleEmitter } from "./emitter.js";

describe("ContextLifecycleEmitter", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-emitter-"));
    filePath = path.join(tmpDir, "test-lifecycle.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a single event to JSONL after flush", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "session:test", "sid-1", 200_000);

    emitter.emit({
      turn: 5,
      rule: "decay:pass",
      beforeTokens: 80_000,
      freedTokens: 5_000,
      afterTokens: 75_000,
    });

    await emitter.flush();

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]);
    expect(event.sessionKey).toBe("session:test");
    expect(event.sessionId).toBe("sid-1");
    expect(event.rule).toBe("decay:pass");
    expect(event.beforeTokens).toBe(80_000);
    expect(event.freedTokens).toBe(5_000);
    expect(event.afterTokens).toBe(75_000);
    expect(event.contextWindow).toBe(200_000);
    expect(event.beforePct).toBe(40);
    expect(event.afterPct).toBe(38);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("computes percentages correctly", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 100_000);

    emitter.emit({
      turn: 1,
      rule: "prune:pass",
      beforeTokens: 71_000,
      freedTokens: 4_000,
      afterTokens: 67_000,
    });

    await emitter.flush();

    const event = JSON.parse((await fs.readFile(filePath, "utf-8")).trim());
    expect(event.beforePct).toBe(71);
    expect(event.afterPct).toBe(67);
  });

  it("handles zero context window without division error", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 0);

    emitter.emit({
      turn: 1,
      rule: "decay:pass",
      beforeTokens: 1000,
      freedTokens: 500,
      afterTokens: 500,
    });

    await emitter.flush();

    const event = JSON.parse((await fs.readFile(filePath, "utf-8")).trim());
    expect(event.beforePct).toBe(0);
    expect(event.afterPct).toBe(0);
  });

  it("buffers multiple events and writes them all on flush", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 200_000);

    for (let i = 0; i < 5; i++) {
      emitter.emit({
        turn: i,
        rule: "decay:strip_thinking",
        beforeTokens: 80_000 - i * 1_000,
        freedTokens: 1_000,
        afterTokens: 79_000 - i * 1_000,
      });
    }

    await emitter.flush();

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      const event = JSON.parse(lines[i]);
      expect(event.turn).toBe(i);
    }
  });

  it("flush is a no-op when buffer is empty", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 200_000);

    await emitter.flush();

    const exists = await fs.access(filePath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it("dispose triggers a flush", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 200_000);

    emitter.emit({
      turn: 1,
      rule: "compact:compaction",
      beforeTokens: 160_000,
      freedTokens: 60_000,
      afterTokens: 100_000,
    });

    await emitter.dispose();

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).rule).toBe("compact:compaction");
  });

  it("creates parent directories on first flush", async () => {
    const nested = path.join(tmpDir, "nested", "deep", "lifecycle.jsonl");
    const emitter = new ContextLifecycleEmitter(nested, "sk", "sid", 200_000);

    emitter.emit({
      turn: 1,
      rule: "decay:pass",
      beforeTokens: 80_000,
      freedTokens: 5_000,
      afterTokens: 75_000,
    });

    await emitter.flush();

    const raw = await fs.readFile(nested, "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("includes details when provided", async () => {
    const emitter = new ContextLifecycleEmitter(filePath, "sk", "sid", 200_000);

    emitter.emit({
      turn: 10,
      rule: "decay:pass",
      beforeTokens: 80_000,
      freedTokens: 5_000,
      afterTokens: 75_000,
      details: { thinkingBlocksStripped: 3, summarizedCount: 2 },
    });

    await emitter.flush();

    const event = JSON.parse((await fs.readFile(filePath, "utf-8")).trim());
    expect(event.details).toEqual({ thinkingBlocksStripped: 3, summarizedCount: 2 });
  });
});
