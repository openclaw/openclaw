import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import { createBeamStore } from "./store.js";
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

it("does not publish an inventory read overtaken by an upload", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), { receivedAt: 100 });
  const oldEntries = await store.keyedStore.entries();
  const delayed = Promise.withResolvers<typeof oldEntries>();
  const entries = vi.spyOn(store.keyedStore, "entries").mockReturnValueOnce(delayed.promise);
  const catalog = createBeamSessionCatalog(store);
  const listing = catalog.list({ agentId: "main" });
  await store.upload(sampleUpload({ title: "New revision" }), { receivedAt: 200 });
  delayed.resolve(oldEntries);
  expect((await listing)[0]?.sessions[0]?.name).toBe("New revision");
  expect(entries).toHaveBeenCalledTimes(2);
});

it("expires cached summaries at storage expiry without rereading transcripts", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), { receivedAt: 1 });
  const rows = (await store.keyedStore.entries()).map(({ key, value, createdAt }) => ({
    key,
    value,
    createdAt,
    expiresAt: 200,
  }));
  const entries = vi.spyOn(store.keyedStore, "entries").mockResolvedValue(rows);
  const clock = vi.spyOn(Date, "now").mockReturnValue(199);
  try {
    expect(await store.list()).toHaveLength(1);
    clock.mockReturnValue(200);
    expect(await store.list()).toEqual([]);
    expect(entries).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

it("refreshes foreign changes in the background and drains its service on stop", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const ctx: OpenClawPluginServiceContext = {
    config: {},
    stateDir: "/unused",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const readEntries = store.keyedStore.entries;
  const entries = vi.spyOn(store.keyedStore, "entries");
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
    const stopped = store.catalogService.stop?.(ctx);
    stoppingRead.resolve([
      { key: "late", value: { ...sampleUpload(), createdAt: 1, receivedAt: 1 }, createdAt: 1 },
    ]);
    await stopped;
    await expect(store.list()).rejects.toThrow("inventory is stopped");
    const callsAtStop = entries.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries).toHaveBeenCalledTimes(callsAtStop);
  } finally {
    await store.catalogService.stop?.(ctx);
    vi.useRealTimers();
  }
});

describe("Beam upload store", () => {
  it.each([
    ["older", "2026-07-20T12:00:00.000099Z", false],
    ["same completed", "2026-07-20T08:00:00.000100-04:00", false],
    ["newer", "2026-07-20T12:00:00.000101Z", true],
  ] as const)(
    "rechecks the %s revision after a competing upload",
    async (_, updatedAt, accepted) => {
      const store = memoryStore();
      const competing: BeamStoredSession = {
        ...sampleUpload({ updatedAt: "2026-07-20T12:00:00.000100Z", completed: true }),
        uploaderProfileId: "competing-publisher",
        createdAt: 50,
        receivedAt: 75,
      };
      const compare = store.keyedStore.compareAndApply.getMockImplementation();
      if (!compare) {
        throw new Error("Beam test store has no comparison implementation");
      }
      store.keyedStore.compareAndApply.mockImplementationOnce(async (...args) => {
        store.values.set(competing.beamId, competing);
        return compare(...args);
      });
      const upload = sampleUpload({ updatedAt, title: "Candidate snapshot" });

      expect(await store.upload(upload, { receivedAt: 100 })).toBe(accepted);
      expect(await store.get(upload.beamId)).toEqual(
        accepted ? { ...upload, createdAt: 50, receivedAt: 100 } : competing,
      );
    },
  );

  it.each(["observe", "compareAndApply"] as const)(
    "refuses uploads when %s support is missing",
    async (missing) => {
      const { keyedStore, values } = memoryStore();
      const store = createBeamStore({
        state: { openKeyedStore: () => ({ ...keyedStore, [missing]: undefined }) },
      } as unknown as PluginRuntime);
      await expect(store.upload(sampleUpload(), { receivedAt: 100 })).rejects.toThrow(
        "require plugin-state observe and compareAndApply",
      );
      expect(values.size).toBe(0);
      expect(keyedStore.observe).not.toHaveBeenCalled();
      expect(keyedStore.compareAndApply).not.toHaveBeenCalled();
    },
  );

  it("returns an uncertain store failure without replaying the upload", async () => {
    const store = memoryStore();
    store.keyedStore.compareAndApply.mockRejectedValueOnce(new Error("unknown write outcome"));
    await expect(store.upload(sampleUpload(), { receivedAt: 100 })).rejects.toThrow(
      "unknown write outcome",
    );
    expect(store.keyedStore.compareAndApply).toHaveBeenCalledTimes(1);
    expect(store.values.size).toBe(0);
  });

  it("captures the upload and receipt before waiting for observation", async () => {
    const store = memoryStore();
    const upload = sampleUpload();
    const original = structuredClone(upload);
    const receipt = { receivedAt: 100, uploaderProfileId: "verified-publisher" };
    const pending = store.upload(upload, receipt);
    upload.title = "Changed after submission";
    for (const item of upload.items) {
      item.text = "Changed after submission";
    }
    receipt.receivedAt = 200;
    receipt.uploaderProfileId = "changed-publisher";
    expect(await pending).toBe(true);
    expect(await store.get(original.beamId)).toEqual({
      ...original,
      createdAt: 100,
      receivedAt: 100,
      uploaderProfileId: "verified-publisher",
    });
  });
});
