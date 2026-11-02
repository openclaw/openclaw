import { expect, it, vi } from "vitest";
import { memoryStore, sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { beamTestServiceContext } from "./beam.test-support.js";
import { createBeamSessionCatalog } from "./session-catalog.js";

it("shares inventory until expiry and invalidates it on upload and delete", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), staffReceipt(100));
  const rows = (await store.keyedStore.entries()).map((row) =>
    Object.assign(row, { expiresAt: 200 }),
  );
  const entries = vi.spyOn(store.keyedStore, "entries").mockResolvedValueOnce(rows);
  const clock = vi.spyOn(Date, "now").mockReturnValue(199);
  const catalog = createBeamSessionCatalog(store);
  const pages = await Promise.all(
    Array.from({ length: 16 }, () => catalog.list({ agentId: "main" })),
  );
  expect(pages.every(([host]) => host?.sessions[0]?.name === "Fix the upload flow")).toBe(true);
  await catalog.list({ agentId: "main", search: "upload" });
  clock.mockReturnValue(200);
  expect(await store.list()).toEqual([]);
  expect(entries).toHaveBeenCalledTimes(1);

  await store.upload(sampleUpload({ title: "Updated title" }), staffReceipt(200));
  expect((await catalog.list({ agentId: "main" }))[0]?.sessions[0]?.name).toBe("Updated title");
  await store.delete(sampleUpload().beamId);
  expect((await catalog.list({ agentId: "main" }))[0]?.sessions).toEqual([]);
});

it("refreshes foreign changes in the background and drains its service on stop", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const ctx = beamTestServiceContext();
  const readEntries = store.keyedStore.entries;
  const entries = vi.spyOn(store.keyedStore, "entries");
  const stop = async () => {
    await ctx.scheduler.stop();
    await store.catalogService.stop?.(ctx);
  };
  try {
    await store.upload(sampleUpload(), staffReceipt(100));
    await store.catalogService.start(ctx);
    store.values.set(sampleUpload().beamId, {
      ...sampleUpload({ title: "Foreign update" }),
      createdAt: 100,
      receivedAt: 200,
    });
    const foreignRows = await readEntries();
    const delayed = Promise.withResolvers<Awaited<ReturnType<typeof readEntries>>>();
    entries.mockReturnValueOnce(delayed.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await store.list())[0]?.title).toBe("Fix the upload flow");
    delayed.resolve(foreignRows);
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
    stoppingRead.resolve(foreignRows);
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
