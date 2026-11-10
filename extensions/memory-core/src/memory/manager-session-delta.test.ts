import type { DatabaseSync } from "node:sqlite";
import { publishSessionTranscriptUpdateByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const { activity } = await vi.hoisted(() => import("./agent-activity.test-support.js"));

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session delta publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  it("yields an interrupted pass and indexes every pending session after the next quiet period", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const manager = await getFreshManager(
      createConfig({ sources: ["sessions"], sessionMemory: true, cacheEnabled: true }),
    );
    onTestFinished(() => manager.close());
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const sessions = Array.from({ length: 9 }, (_, index) => ({
      sessionId: `resume-${index}`,
      sessionKey: `agent:main:chat:resume-${index}`,
    }));
    for (const session of sessions) {
      await seedSessionTranscript({
        ...session,
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: `resumeproof alpha ${session.sessionId}`,
          },
        ],
      });
      await publishSessionTranscriptUpdateByIdentity({ agentId: "main", ...session });
    }
    fixture.provider.beforeEmbedBatch = async () => {
      fixture.provider.beforeEmbedBatch = null;
      activity.listener?.(true);
    };
    const indexedPaths = () =>
      database
        .prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions' ORDER BY path")
        .all();

    await vi.advanceTimersByTimeAsync(30_000);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    expect(fixture.provider.embedBatchCalls).toBeGreaterThan(0);
    expect(indexedPaths()).toEqual([]);

    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(indexedPaths()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    expect(indexedPaths()).toEqual(
      sessions.map(({ sessionId }) => ({ path: `sessions/main/${sessionId}.jsonl` })),
    );
    expect(
      database
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
        )
        .all("resumeproof"),
    ).toEqual(indexedPaths());
    expect(manager.status().dirty).toBe(false);
  });

  it("keeps the published index when a background rebuild is interrupted", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const session = { sessionId: "rebuild", sessionKey: "agent:main:chat:rebuild" };
    await seedSessionTranscript({
      ...session,
      messages: [{ role: "user", timestamp: Date.now(), content: "stableproof original" }],
    });
    const manager = await getFreshManager(
      createConfig({ sources: ["sessions"], sessionMemory: true }),
    );
    onTestFinished(() => manager.close());
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const before = readPublishedSessionIndex(
      database,
      "sessions/main/rebuild.jsonl",
      "stableproof",
    );
    await seedSessionTranscript({
      ...session,
      messages: [{ role: "user", timestamp: Date.now(), content: "newproof appended" }],
    });
    Reflect.set(manager, "memoryFullRetryDirty", true);
    fixture.provider.beforeEmbedBatch = async () => {
      fixture.provider.beforeEmbedBatch = null;
      activity.listener?.(true);
    };
    await publishSessionTranscriptUpdateByIdentity({ agentId: "main", ...session });
    await vi.advanceTimersByTimeAsync(30_000);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    expect(
      readPublishedSessionIndex(database, "sessions/main/rebuild.jsonl", "stableproof"),
    ).toEqual(before);
    expect(manager.status().dirty).toBe(true);

    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    expect(
      readPublishedSessionIndex(database, "sessions/main/rebuild.jsonl", "newproof").search,
    ).not.toEqual([]);
    expect(manager.status().dirty).toBe(false);
  });

  it("settles ten queued turns incrementally with the same search results as a full reindex", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
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
    const manager = await getFreshManager(cfg);
    onTestFinished(() => manager.close());
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
    await seedSessionTranscript({ sessionId, sessionKey, messages: [1, 2, 3, 4].map(turn) });
    await manager.sync({ reason: "initial", force: true });
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const initial = readPublishedSessionIndex(database, sessionPath, "turnmarker1");
    const before = initial.chunks;
    expect(before.length).toBeGreaterThan(2);

    fixture.provider.embeddedBatchTexts = [];
    for (let index = 5; index < 15; index += 1) {
      await seedSessionTranscript({ sessionId, sessionKey, messages: [turn(index)] });
      await publishSessionTranscriptUpdateByIdentity({ agentId: "main", sessionId, sessionKey });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(readPublishedSessionIndex(database, sessionPath, "turnmarker14").search).toEqual([]);
    expect(fixture.provider.embeddedBatchTexts).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    await (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();

    const after = readPublishedSessionIndex(database, sessionPath, "turnmarker14");
    expect(after.search).not.toEqual([]);
    const kept = before.filter((row) => after.chunks.some((next) => next.id === row.id));
    // Only the trailing chunk may change; every earlier row stays untouched.
    expect(kept.length).toBeGreaterThanOrEqual(before.length - 1);
    expect(after.chunks).toEqual(expect.arrayContaining(kept));
    expect(readPublishedSessionIndex(database, sessionPath, "turnmarker1").search).toEqual(
      initial.search,
    );
    expect(fixture.provider.embeddedBatchTexts.some((text) => /\bturnmarker1\b/.test(text))).toBe(
      false,
    );
    expect(fixture.provider.embeddedBatchTexts.some((text) => text.includes("turnmarker14"))).toBe(
      true,
    );
    expect(manager.status().dirty).toBe(false);
    const search = async () =>
      (await manager.search("turnmarker14", { lexicalOnly: true, sources: ["sessions"] })).map(
        ({ path, startLine, endLine, snippet, source }) => ({
          path,
          startLine,
          endLine,
          snippet,
          source,
        }),
      );
    const incrementalResults = await search();
    expect(incrementalResults.length).toBeGreaterThan(0);
    await manager.sync({ reason: "full-comparison", force: true });
    expect(await search()).toEqual(incrementalResults);
  });
});
