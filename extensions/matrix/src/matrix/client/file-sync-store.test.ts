import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileBackedMatrixSyncStore, parsePersistedMatrixSyncStore } from "./file-sync-store.js";
import { readMatrixStorageMetadata, writeMatrixStorageMetadata } from "./storage-meta-state.js";

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

describe("FileBackedMatrixSyncStore", () => {
  const tempDirs: string[] = [];

  function createStoragePath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "state"));
    return path.join(tempDir, "bot-storage.json");
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists sync data so restart resumes from the saved cursor", async () => {
    const storagePath = createStoragePath();

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
    expect(savedSync?.roomsData.join?.["!room:example.org"]).toMatchObject({
      timeline: {
        events: [
          {
            event_id: "$message",
            sender: "@user:example.org",
            type: "m.room.message",
          },
        ],
      },
    });
    expect(secondStore.hasSavedSyncFromCleanShutdown()).toBe(false);
  });

  it("claims current-token storage ownership when sync state is persisted", async () => {
    const storagePath = createStoragePath();
    const rootDir = path.dirname(storagePath);
    writeMatrixStorageMetadata(rootDir, {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accountId: "default",
      accessTokenHash: "token-hash",
      deviceId: null,
    });

    const store = new FileBackedMatrixSyncStore(storagePath);
    await store.setSyncData(createSyncResponse("claimed-token"));
    await store.flush();

    const meta = readMatrixStorageMetadata(rootDir);
    expect(meta.currentTokenStateClaimed).toBe(true);
  });

  it("only treats sync state as restart-safe after a clean shutdown persist", async () => {
    const storagePath = createStoragePath();

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
    const storagePath = createStoragePath();

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
    const storagePath = createStoragePath();

    const store = new FileBackedMatrixSyncStore(storagePath);
    await store.setSyncData(createSyncResponse("s111"));
    await store.setSyncData(createSyncResponse("s222"));
    await store.storeClientOptions({ lazyLoadMembers: true });

    expect(new FileBackedMatrixSyncStore(storagePath).hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(249);
    expect(new FileBackedMatrixSyncStore(storagePath).hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    const persisted = new FileBackedMatrixSyncStore(storagePath);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("s222");
    await expect(persisted.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });

    await store.flush();
  });

  it("flushes a scheduled persist before shutdown returns", async () => {
    vi.useFakeTimers();
    const storagePath = createStoragePath();

    const store = new FileBackedMatrixSyncStore(storagePath);
    await store.setSyncData(createSyncResponse("s777"));
    await store.flush();

    const persisted = new FileBackedMatrixSyncStore(storagePath);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("s777");
  });

  it("persists client options alongside sync state", async () => {
    const storagePath = createStoragePath();

    const firstStore = new FileBackedMatrixSyncStore(storagePath);
    await firstStore.storeClientOptions({ lazyLoadMembers: true });
    await firstStore.flush();

    const secondStore = new FileBackedMatrixSyncStore(storagePath);
    await expect(secondStore.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("parses legacy raw sync payloads for doctor migration", () => {
    const parsed = parsePersistedMatrixSyncStore(
      JSON.stringify({
        next_batch: "legacy-token",
        rooms: {
          join: {},
        },
        account_data: {
          events: [],
        },
      }),
    );

    expect(parsed).toMatchObject({
      savedSync: {
        nextBatch: "legacy-token",
        roomsData: {
          join: {},
        },
        accountData: [],
      },
    });
  });
});
