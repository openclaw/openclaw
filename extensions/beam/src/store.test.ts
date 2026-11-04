import { expect, it, vi } from "vitest";
import {
  memoryStore,
  sampleUpload,
  staffReceipt,
  releaseSource,
} from "./beam-store.test-support.js";
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
  await releaseSource(store);
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

it("never restores source ownership or replaces the binding after snapshot archive", async () => {
  const store = memoryStore();
  const generation = await releaseSource(store);
  const original = (await store.get(sampleUpload().beamId))!;
  const first = await store.reserveContinuation(original, "main", () => {});
  await first.beginCreate(() => {});
  await first.complete(() => {});
  await store.delete(original.beamId);
  expect(await store.upload(sampleUpload(), staffReceipt(200))).toEqual({
    kind: "handoff",
    id: generation,
    accepted: false,
  });
  const replacement = (await store.get(original.beamId))!;
  expect(replacement.items).toEqual([]);
  const second = await store.reserveContinuation(replacement, "other", () => {});
  expect(second.session.continuation?.sessionKey).toBe(first.session.continuation?.sessionKey);
  expect(await store.list()).toEqual([]);
  const [host] = await createBeamSessionCatalog(store).list({
    agentId: "main",
    search: original.beamId.slice(0, 12),
  });
  expect(host?.sessions[0]?.sessionKey).toBe(first.session.continuation?.sessionKey);
});

it("captures immutable handoff history and keeps an existing reservation noncreating", async () => {
  const store = memoryStore();
  await releaseSource(store);
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
  await releaseSource(store);
  const source = (await store.get(sampleUpload().beamId))!;
  let current = true;
  const first = await store.reserveContinuation(source, "main", () => {
    if (!current) {
      throw new Error("source grant revoked");
    }
  });
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
  current = false;
  expect(() => first.assertCurrent()).toThrow("source grant revoked");
  await first.rollback();
  current = true;
  expect(await first.beginCreate(() => {})).toBe(false);
  const retry = await store.reserveContinuation(
    (await store.get(source.beamId))!,
    "main",
    () => {},
  );
  expect(retry.reservedNow).toBe(true);
  expect(retry.session.continuation?.sessionKey).toBe(key);
  expect(await retry.beginCreate(() => {})).toBe(true);
  await expect(first.rollback()).rejects.toThrow("creation attempt changed");
  await expect(first.complete(() => {})).rejects.toThrow("creation attempt changed");
  await expect(uncertain.rollback()).rejects.toThrow("did not create");
  await retry.complete(() => {});
});

it("upgrades a persisted owned snapshot through refresh, release, and one destination", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
  const releases: Array<() => void> = [];
  try {
    // Pre-handoff receivers stored owned snapshots without generation or binding fields.
    const upload = sampleUpload();
    const original = {
      ...upload,
      publisherProfileId: "original-publisher",
      uploaderProfileId: "original-publisher",
      createdAt: 50,
      receivedAt: 100,
    };
    await keyedStore.register(upload.beamId, original);
    const catalog = createBeamSessionCatalog(store);
    const params = {
      hostId: "gateway",
      threadId: upload.beamId,
      agentId: "main",
      assertCurrent() {},
    };
    expect((await catalog.list({ agentId: "main" }))[0]?.sessions[0]).toMatchObject({
      threadId: upload.beamId,
      canContinue: false,
      continuationUnavailableReasonCode: "source-handoff-required",
    });
    expect((await catalog.read(params)).items).toHaveLength(upload.items.length);
    expect(await catalog.resolveGatewayConversation!(params)).toBeUndefined();
    await expect(catalog.copyToGatewaySession!(params)).rejects.toThrow("source still owns");
    expect(await keyedStore.lookup(upload.beamId)).toEqual(original);

    const receipt = {
      ...staffReceipt(200),
      publisher: { kind: "guest" as const, profileId: "original-publisher" },
    };
    const published = await store.upload(upload, receipt);
    expect(published).toMatchObject({ kind: "published", applied: true, id: expect.any(String) });
    const refreshed = (await store.get(upload.beamId))!;
    expect(refreshed).toMatchObject({
      ...original,
      receivedAt: 200,
      publicationId: expect.any(String),
    });
    expect(await store.upload({ ...upload, handoffId: refreshed.publicationId }, receipt)).toEqual({
      kind: "handoff",
      id: refreshed.publicationId,
      accepted: true,
    });
    const handedOff = (await catalog.list({ agentId: "main" }))[0]?.sessions[0];
    expect(handedOff?.canContinue).toBe(true);
    expect(handedOff).not.toHaveProperty("continuationUnavailableReasonCode");
    const first = (await catalog.copyToGatewaySession!(params)).continuation!;
    releases.push(first.release);
    expect(await first.beginCreate(() => {})).toBe(true);
    await first.complete(() => {});
    const reopened = (await createBeamSessionCatalog(store).copyToGatewaySession!(params))
      .continuation!;
    releases.push(reopened.release);
    expect(reopened.reservedNow).toBe(false);
    expect(reopened.sessionKey).toBe(first.sessionKey);
    expect((await store.get(upload.beamId))?.createdAt).toBe(original.createdAt);
  } finally {
    for (const release of releases) {
      release();
    }
    await close();
  }
});

it.each(["complete", "rollback"] as const)(
  "settles an exact %s claim after snapshot removal without restoring it",
  async (action) => {
    const { store, keyedStore, handoffStore, close } = await persistentBeamTestStore();
    const releases: Array<() => void> = [];
    let current = true;
    try {
      await releaseSource(store);
      const source = (await store.get(sampleUpload().beamId))!;
      const owner = await store.reserveContinuation(source, "main", () => {
        if (!current) {
          throw new Error("source grant revoked");
        }
      });
      releases.push(owner.release);
      expect(await owner.beginCreate(() => {})).toBe(true);
      const claimed = (await handoffStore.lookup(source.beamId))!.continuation!;
      expect(claimed).toMatchObject({
        ...owner.session.continuation,
        creating: expect.any(String),
      });
      await store.delete(source.beamId);
      const retained = (await store.get(source.beamId))!;
      expect(retained.items).toEqual([]);
      const catalog = createBeamSessionCatalog(store);
      expect(
        (await catalog.list({ agentId: "main", search: source.beamId.slice(0, 12) }))[0]
          ?.sessions[0]?.sessionKey,
      ).toBe(owner.session.continuation?.sessionKey);
      const resolved = await catalog.resolveGatewayConversation!({
        hostId: "gateway",
        threadId: source.beamId,
        assertCurrent() {},
      });
      expect(resolved?.sessionKey).toBe(owner.session.continuation?.sessionKey);
      if (resolved) {
        releases.push(resolved.release);
      }
      const reconciled = await store.reserveContinuation(retained, "main", () => {});
      releases.push(reconciled.release);
      if (action === "complete") {
        // A new lease completes only after core verifies the existing destination's provenance.
        await reconciled.complete(() => {});
        expect((await store.get(source.beamId))?.continuation?.ready).toBe(true);
        await expect(reconciled.rollback()).rejects.toThrow("did not create");
        const before = await handoffStore.lookup(source.beamId);
        expect(before?.continuation).toEqual({ ...claimed, ready: true });
        await expect(owner.rollback()).rejects.toMatchObject({
          name: "PluginStateStoreError",
          code: "PLUGIN_STATE_WRITE_FAILED",
          operation: "register",
        });
        expect(await handoffStore.lookup(source.beamId)).toEqual(before);
      } else {
        current = false;
        await owner.rollback();
        expect((await store.get(source.beamId))?.continuation?.creating).toBeUndefined();
        const before = await handoffStore.lookup(source.beamId);
        expect(before?.continuation).toEqual({
          id: claimed.id,
          agentId: claimed.agentId,
          sessionKey: claimed.sessionKey,
        });
        await expect(reconciled.complete(() => {})).rejects.toMatchObject({
          name: "PluginStateStoreError",
          code: "PLUGIN_STATE_WRITE_FAILED",
          operation: "register",
        });
        expect(await handoffStore.lookup(source.beamId)).toEqual(before);
      }
      expect(await keyedStore.lookup(source.beamId)).toBeUndefined();
      expect(await store.upload(sampleUpload(), staffReceipt(400))).toMatchObject({
        kind: "handoff",
        accepted: false,
      });
    } finally {
      for (const release of releases) {
        release();
      }
      await close();
    }
  },
);

it("retains a native selected-publication guard across unrelated and ownership-preserving uploads", async () => {
  const { store, close } = await persistentBeamTestStore();
  let release: (() => void) | undefined;
  try {
    await releaseSource(store);
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
    handoff.assertCurrent();
    expect(await store.upload(sampleUpload(), staffReceipt(400))).toMatchObject({
      kind: "handoff",
      accepted: false,
    });
  } finally {
    release?.();
    await close();
  }
});
