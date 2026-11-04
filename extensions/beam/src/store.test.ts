import { expect, it, vi } from "vitest";
import { memoryStore, sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { beamTestServiceContext, persistentBeamTestStore } from "./beam.test-support.js";
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

it("binds one destination across agents, repeated requests, and later source uploads", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), staffReceipt(100));
  const source = (await store.get(sampleUpload().beamId))!;
  const attempts = await Promise.all(
    ["main", "research"].map((agent) => store.reserveContinuation(source, agent, () => {})),
  );
  const binding = attempts[0]!.session.continuation!;
  expect(attempts.map(({ reservedNow }) => reservedNow)).toEqual([true, true]);
  expect(await attempts[0]!.beginCreate(() => {})).toBe(true);
  expect(await attempts[1]!.beginCreate(() => {})).toBe(false);
  await attempts[0]!.complete(() => {});
  expect(attempts[1]!.session.continuation).toEqual(binding);
  await store.upload(
    sampleUpload({
      updatedAt: "2026-07-21T12:00:00Z",
      truncated: true,
      items: [{ type: "agentMessage", text: "Late source snapshot" }],
    }),
    staffReceipt(200),
  );
  expect((await store.get(source.beamId))?.continuation).toMatchObject(binding);
  const reopened = createBeamSessionCatalog(store);
  expect((await reopened.list({ agentId: "research" }))[0]?.sessions[0]?.sessionKey).toBe(
    binding.sessionKey,
  );
  const retried = await store.reserveContinuation(
    (await store.get(source.beamId))!,
    "other",
    () => {},
  );
  expect(retried.reservedNow).toBe(false);
  expect(retried.session.continuation).toMatchObject(binding);
});

it("does not inherit a deleted publication's handoff or reserve under stale ownership", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), staffReceipt(100));
  const original = (await store.get(sampleUpload().beamId))!;
  const first = await store.reserveContinuation(original, "main", () => {});
  await store.delete(original.beamId);
  await store.upload(sampleUpload(), {
    ...staffReceipt(200),
    publisher: { kind: "staff", profileId: "new-publisher" },
  });
  await expect(store.reserveContinuation(original, "main", () => {})).rejects.toThrow(
    "publication changed",
  );
  const replacement = (await store.get(original.beamId))!;
  expect(replacement.continuation).toBeUndefined();
  const second = await store.reserveContinuation(replacement, "main", () => {});
  expect(second.session.continuation?.sessionKey).not.toBe(first.session.continuation?.sessionKey);
});

it("captures immutable handoff history and keeps an existing reservation noncreating", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), staffReceipt(100));
  const catalog = createBeamSessionCatalog(store);
  const params = {
    hostId: "gateway",
    threadId: sampleUpload().beamId,
    agentId: "main",
    assertCurrent() {},
  };
  const first = (await catalog.copyToGatewaySession!(params)).continuation!;
  expect(await first.beginCreate(() => {})).toBe(true);
  await first.complete(() => {});
  await store.upload(
    sampleUpload({
      updatedAt: "2026-07-21T12:00:00Z",
      items: [{ type: "userMessage", text: "Different source history" }],
    }),
    staffReceipt(200),
  );
  const captured = await first.read(params);
  expect(captured.items.map(({ text }) => text)).not.toContain("Different source history");
  const second = (await createBeamSessionCatalog(store).copyToGatewaySession!(params))
    .continuation!;
  expect(second.reservedNow).toBe(false);
  expect(second.sessionKey).toBe(first.sessionKey);
});

it("retries an unclaimed or proven rolled-back creation at the same key, but never an uncertain one", async () => {
  const store = memoryStore();
  await store.upload(sampleUpload(), staffReceipt(100));
  const source = (await store.get(sampleUpload().beamId))!;
  const first = await store.reserveContinuation(source, "main", () => {});
  const key = first.session.continuation!.sessionKey;
  const beforeDispatch = await store.reserveContinuation(
    (await store.get(source.beamId))!,
    "main",
    () => {},
  );
  expect(beforeDispatch.reservedNow).toBe(true);
  expect(await first.beginCreate(() => {})).toBe(true);
  const uncertain = await store.reserveContinuation(
    (await store.get(source.beamId))!,
    "main",
    () => {},
  );
  expect(uncertain.reservedNow).toBe(false);
  expect(await uncertain.beginCreate(() => {})).toBe(false);
  await first.rollback();
  const retry = await store.reserveContinuation(
    (await store.get(source.beamId))!,
    "main",
    () => {},
  );
  expect(retry.reservedNow).toBe(true);
  expect(retry.session.continuation?.sessionKey).toBe(key);
  expect(await retry.beginCreate(() => {})).toBe(true);
});

it("retains a native selected-publication guard across unrelated and ownership-preserving uploads", async () => {
  const { store, close } = persistentBeamTestStore();
  let release: (() => void) | undefined;
  try {
    await store.upload(sampleUpload(), staffReceipt(100));
    const selected = (await store.get(sampleUpload().beamId))!;
    const handoff = await store.reserveContinuation(selected, "main", () => {});
    release = handoff.release;
    await store.upload(sampleUpload({ beamId: "f".repeat(32) }), staffReceipt(200));
    handoff.assertCurrent();
    await store.delete("f".repeat(32));
    handoff.assertCurrent();
    expect(await handoff.beginCreate(() => {})).toBe(true);
    await store.upload(
      sampleUpload({ updatedAt: "2026-07-21T12:00:00Z", title: "Later projection" }),
      staffReceipt(300),
    );
    handoff.assertCurrent();
    await handoff.complete(() => {});
    handoff.assertCurrent();
    expect((await store.list())[0]?.continuation?.ready).toBe(true);
    await store.delete(selected.beamId);
    expect(handoff.assertCurrent).toThrow();
  } finally {
    release?.();
    await close();
  }
});
