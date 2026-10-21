import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import type { BeamStoredSession } from "./types.js";

it("shares one inventory read across concurrent and repeated catalog lists", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), { receivedAt: 100 });
  const entries = vi.spyOn(store.keyedStore, "entries");
  const catalog = createBeamSessionCatalog(store);
  const pages = await Promise.all(
    Array.from({ length: 16 }, () => catalog.list({ agentId: "main" })),
  );
  expect(pages.every(([host]) => host?.sessions[0]?.name === "Fix the upload flow")).toBe(true);
  expect(entries).toHaveBeenCalledTimes(1);
  await catalog.list({ agentId: "main", search: "upload" });
  expect(entries).toHaveBeenCalledTimes(1);

  await store.upload(sampleUpload({ title: "Updated title" }), { receivedAt: 200 });
  expect((await catalog.list({ agentId: "main" }))[0]?.sessions[0]?.name).toBe("Updated title");
  expect(entries).toHaveBeenCalledTimes(2);
  await store.delete(sampleUpload().beamId);
  expect((await catalog.list({ agentId: "main" }))[0]?.sessions).toEqual([]);
});

it("expires cached summaries at storage expiry without rereading transcripts", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), { receivedAt: 1 });
  const rows = (await store.keyedStore.entries()).map((row) =>
    Object.assign(row, { expiresAt: 200 }),
  );
  const entries = vi.spyOn(store.keyedStore, "entries").mockResolvedValue(rows);
  const clock = vi.spyOn(Date, "now").mockReturnValue(199);
  onTestFinished(() => clock.mockRestore());
  expect(await store.list()).toHaveLength(1);
  clock.mockReturnValue(200);
  expect(await store.list()).toEqual([]);
  expect(entries).toHaveBeenCalledTimes(1);
});

it("refreshes foreign changes in the background and drains its service on stop", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const ctx: OpenClawPluginServiceContextV2 = {
    config: {},
    scheduler: createTestPluginServiceScheduler(),
    stateDir: "/unused",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const readEntries = store.keyedStore.entries;
  const entries = vi.spyOn(store.keyedStore, "entries");
  const stop = async () => {
    await ctx.scheduler.stop();
    await store.catalogService.stop?.(ctx);
  };
  try {
    await store.upload(sampleUpload(), { receivedAt: 100 });
    await store.catalogService.start(ctx);
    store.values.set(sampleUpload().beamId, {
      ...sampleUpload({ title: "Foreign update" }),
      createdAt: 100,
      receivedAt: 200,
    });
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof readEntries>>>();
    entries.mockReturnValueOnce(delayed.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await store.list())[0]?.title).toBe("Fix the upload flow");
    delayed.resolve(await readEntries());
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.list())[0]?.title).toBe("Foreign update");

    entries.mockRejectedValue(new Error("inventory unavailable"));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(store.list()).rejects.toThrow("inventory unavailable");
    expect(ctx.logger.warn).toHaveBeenCalled();
    entries.mockImplementation(readEntries);
    store.values.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await store.list()).toEqual([]);

    const stoppingRead = Promise.withResolvers<Awaited<ReturnType<typeof readEntries>>>();
    entries.mockReturnValueOnce(stoppingRead.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = stop();
    stoppingRead.resolve([
      { key: "late", value: { ...sampleUpload(), createdAt: 1, receivedAt: 1 }, createdAt: 1 },
    ]);
    await stopped;
    await expect(store.list()).rejects.toThrow("inventory is stopped");
    const callsAtStop = entries.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries).toHaveBeenCalledTimes(callsAtStop);
  } finally {
    await stop();
    vi.useRealTimers();
  }
});

it.each([
  ["older", "2026-07-20T12:00:00.000099Z", false],
  ["same completed", "2026-07-20T08:00:00.000100-04:00", false],
  ["newer", "2026-07-20T12:00:00.000101Z", true],
] as const)("rechecks the %s revision after a competing upload", async (_, updatedAt, accepted) => {
  const store = memoryStore();
  const competing: BeamStoredSession = {
    ...sampleUpload({ updatedAt: "2026-07-20T12:00:00.000100Z", completed: true }),
    uploaderProfileId: "competing-publisher",
    createdAt: 50,
    receivedAt: 75,
  };
  const compare = store.keyedStore.compareAndApply.getMockImplementation();
  assert(compare, "Beam test store has no comparison implementation");
  store.keyedStore.compareAndApply.mockImplementationOnce(async (...args) => {
    store.values.set(competing.beamId, competing);
    return compare(...args);
  });
  const upload = sampleUpload({ updatedAt, title: "Candidate snapshot" });

  expect(await store.upload(upload, { receivedAt: 100 })).toBe(accepted);
  expect(await store.get(upload.beamId)).toEqual(
    accepted ? { ...upload, createdAt: 50, receivedAt: 100 } : competing,
  );
});
