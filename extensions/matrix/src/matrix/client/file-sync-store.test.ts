import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ISyncResponse } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../../../../../src/infra/json-files.js";
import { FileBackedMatrixSyncStore } from "./file-sync-store.js";

function createSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        "!room:example.org": {
          summary: {
            "m.heroes": [],
          },
          state: { events: [] },
          timeline: {
            events: [
              {
                content: {
                  body: "hello",
                  msgtype: "m.text",
                },
                event_id: "$message",
                origin_server_ts: 1,
                sender: "@user:example.org",
                type: "m.room.message",
              },
            ],
            prev_batch: "t0",
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: {
      events: [
        {
          content: { theme: "dark" },
          type: "com.openclaw.test",
        },
      ],
    },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileBackedMatrixSyncStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists sync data so restart resumes from the saved cursor", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    expect(firstStore.hasSavedSync()).toBe(false);
    await firstStore.setSyncData(createSyncResponse("s123"));
    await firstStore.flush();

    const secondStore = new FileBackedMatrixSyncStore(storagePath);
    expect(secondStore.hasSavedSync()).toBe(true);
    await expect(secondStore.getSavedSyncToken()).resolves.toBe("s123");

    const savedSync = await secondStore.getSavedSync();
    expect(savedSync?.nextBatch).toBe("s123");
    expect(savedSync?.accountData).toEqual([
      {
        content: { theme: "dark" },
        type: "com.openclaw.test",
      },
    ]);
    expect(savedSync?.roomsData.join?.["!room:example.org"]).toBeTruthy();
    expect(secondStore.hasSavedSyncFromCleanShutdown()).toBe(false);
  });

  it("only treats sync state as restart-safe after a clean shutdown persist", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    await firstStore.setSyncData(createSyncResponse("s123"));
    await firstStore.flush();

    const afterDirtyPersist = new FileBackedMatrixSyncStore(storagePath);
    expect(afterDirtyPersist.hasSavedSync()).toBe(true);
    expect(afterDirtyPersist.hasSavedSyncFromCleanShutdown()).toBe(false);

    firstStore.markCleanShutdown();
    await firstStore.flush();

    const afterCleanShutdown = new FileBackedMatrixSyncStore(storagePath);
    expect(afterCleanShutdown.hasSavedSync()).toBe(true);
    expect(afterCleanShutdown.hasSavedSyncFromCleanShutdown()).toBe(true);
  });

  it("clears the clean-shutdown marker once fresh sync data arrives", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    await firstStore.setSyncData(createSyncResponse("s123"));
    firstStore.markCleanShutdown();
    await firstStore.flush();

    const restartedStore = new FileBackedMatrixSyncStore(storagePath);
    expect(restartedStore.hasSavedSyncFromCleanShutdown()).toBe(true);

    await restartedStore.setSyncData(createSyncResponse("s456"));
    await restartedStore.flush();

    const afterNewSync = new FileBackedMatrixSyncStore(storagePath);
    expect(afterNewSync.hasSavedSync()).toBe(true);
    expect(afterNewSync.hasSavedSyncFromCleanShutdown()).toBe(false);
    await expect(afterNewSync.getSavedSyncToken()).resolves.toBe("s456");
  });

  it("coalesces background persistence until the debounce window elapses", async () => {
    vi.useFakeTimers();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");
    const writeSpy = vi.spyOn(jsonFiles, "writeJsonAtomic").mockResolvedValue();

    const store = new FileBackedMatrixSyncStore(storagePath);
    await store.setSyncData(createSyncResponse("s111"));
    await store.setSyncData(createSyncResponse("s222"));
    await store.storeClientOptions({ lazyLoadMembers: true });

    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(
      storagePath,
      expect.objectContaining({
        savedSync: expect.objectContaining({
          nextBatch: "s222",
        }),
        clientOptions: {
          lazyLoadMembers: true,
        },
      }),
      expect.any(Object),
    );
  });

  it("waits for an in-flight persist when shutdown flush runs", async () => {
    vi.useFakeTimers();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");
    const writeDeferred = createDeferred();
    const writeSpy = vi
      .spyOn(jsonFiles, "writeJsonAtomic")
      .mockImplementation(async () => writeDeferred.promise);

    const store = new FileBackedMatrixSyncStore(storagePath);
    await store.setSyncData(createSyncResponse("s777"));
    await vi.advanceTimersByTimeAsync(250);

    let flushCompleted = false;
    const flushPromise = store.flush().then(() => {
      flushCompleted = true;
    });

    await Promise.resolve();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(flushCompleted).toBe(false);

    writeDeferred.resolve();
    await flushPromise;
    expect(flushCompleted).toBe(true);
  });

  it("persists client options alongside sync state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    await firstStore.storeClientOptions({ lazyLoadMembers: true });
    await firstStore.flush();

    const secondStore = new FileBackedMatrixSyncStore(storagePath);
    await expect(secondStore.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("loads legacy raw sync payloads from bot-storage.json", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    const storagePath = path.join(tempDir, "bot-storage.json");

    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        next_batch: "legacy-token",
        rooms: {
          join: {},
        },
        account_data: {
          events: [],
        },
      }),
      "utf8",
    );

    const store = new FileBackedMatrixSyncStore(storagePath);
    expect(store.hasSavedSync()).toBe(true);
    await expect(store.getSavedSyncToken()).resolves.toBe("legacy-token");
    await expect(store.getSavedSync()).resolves.toMatchObject({
      nextBatch: "legacy-token",
      roomsData: {
        join: {},
      },
      accountData: [],
    });
  });
});
