import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session delta publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it("embeds and writes only new chunks when a session transcript grows", async () => {
    const sessionId = "growing-session";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    // Each long turn fills its own chunk, so appends leave earlier chunks unchanged.
    const turn = (index: number) => ({
      role: "user" as const,
      timestamp: Date.now(),
      content: `turnmarker${index} ` + `topic${index} detail `.repeat(400),
    });
    const cfg = createConfig({ sources: ["sessions"], sessionMemory: true, cacheEnabled: false });
    const manager = await getFreshManager(cfg, "cli");
    await seedSessionTranscript({ sessionId, sessionKey, messages: [1, 2, 3, 4].map(turn) });
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const before = readPublishedSessionIndex(database, sessionPath, "turnmarker1").chunks;
    expect(before.length).toBeGreaterThan(2);

    await seedSessionTranscript({ sessionId, sessionKey, messages: [turn(5)] });
    fixture.provider.embeddedBatchTexts = [];
    await manager.sync({
      reason: "append",
      sessions: [{ agentId: "main", sessionId, sessionKey }],
    });

    const after = readPublishedSessionIndex(database, sessionPath, "turnmarker5");
    expect(after.search).not.toEqual([]);
    const kept = before.filter((row) => after.chunks.some((next) => next.id === row.id));
    // Only the trailing chunk may change; every earlier row stays untouched.
    expect(kept.length).toBeGreaterThanOrEqual(before.length - 1);
    expect(after.chunks).toEqual(expect.arrayContaining(kept));
    expect(fixture.provider.embeddedBatchTexts.some((text) => text.includes("turnmarker1"))).toBe(
      false,
    );
    expect(fixture.provider.embeddedBatchTexts.some((text) => text.includes("turnmarker5"))).toBe(
      true,
    );
    expect(manager.status().dirty).toBe(false);
  });
});
