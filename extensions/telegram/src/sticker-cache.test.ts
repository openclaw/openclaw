import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import * as stickerCache from "./sticker-cache-store.js";

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-sticker-cache",
}));

describe("sticker-cache", () => {
  type StickerEntry = stickerCache.CachedSticker;
  let store: PluginStateKeyedStore<StickerEntry>;
  const openStore = () =>
    createPluginStateKeyedStoreForTests<StickerEntry>("telegram", {
      namespace: "telegram.sticker-cache",
      maxEntries: 10_000,
    });
  const sticker = (fileId: string, overrides: Partial<StickerEntry> = {}): StickerEntry => ({
    fileId,
    fileUniqueId: `${fileId}-unique`,
    description: `${fileId} sticker`,
    cachedAt: "2026-01-26T10:00:00.000Z",
    ...overrides,
  });

  function installStore(nextStore: PluginStateKeyedStore<StickerEntry>): void {
    store = nextStore;
    setTelegramRuntime({
      state: {
        openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  }

  beforeEach(async () => {
    resetPluginStateStoreForTests({ closeDatabase: false });
    installStore(openStore());
    await store.clear();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("returns the best-effort fallback when plugin-state register rejects", async () => {
    installStore({
      ...store,
      async register() {
        await Promise.resolve();
        throw new Error("register failed");
      },
    });
    await expect(stickerCache.cacheSticker(sticker("file-failure"))).resolves.toBeUndefined();
  });

  it("settles only after the backing write commits", async () => {
    const backingStore = store;
    await stickerCache.cacheSticker(
      sticker("original-file", {
        fileUniqueId: "delayed-unique",
        description: "Original sticker",
        setName: "OriginalSet",
        cachedAt: "2026-01-26T11:00:00.000Z",
      }),
    );
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    installStore({
      ...backingStore,
      async register(key, value, options) {
        entered.resolve();
        await release.promise;
        await backingStore.register(key, value, options);
      },
    });
    const replacement = sticker("delayed-file", {
      fileUniqueId: "delayed-unique",
      emoji: undefined,
      setName: undefined,
      receivedFrom: undefined,
      description: "A delayed sticker",
      cachedAt: "2026-01-26T12:00:00.000Z",
    });
    let settled = false;
    const pending = stickerCache.cacheSticker(replacement).then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(await stickerCache.getCachedSticker("delayed-unique")).toMatchObject({
        fileId: "original-file",
        description: "Original sticker",
        setName: "OriginalSet",
      });
    } finally {
      release.resolve();
      await pending;
    }
    resetPluginStateStoreForTests();
    installStore(openStore());
    expect(await stickerCache.getCachedSticker("delayed-unique")).toStrictEqual({
      fileId: "delayed-file",
      fileUniqueId: "delayed-unique",
      description: "A delayed sticker",
      cachedAt: "2026-01-26T12:00:00.000Z",
    });
  });

  describe("searchStickers", () => {
    beforeEach(async () => {
      for (const [fileId, emoji, setName, description] of [
        ["fox1", "🦊", "CuteFoxes", "A fox waving"],
        ["fox2", "🦊", "CuteFoxes", "A fox sleeping"],
        ["cat1", "🐱", "FunnyCats", "A cat sitting"],
      ] as const) {
        await stickerCache.cacheSticker(sticker(fileId, { emoji, setName, description }));
      }
    });
    it.each([
      { query: "🦊", limit: undefined, ids: ["fox1-unique", "fox2-unique"] },
      { query: "FOX", limit: 1, ids: ["fox1-unique"] },
    ])("finds $query with limit $limit", async ({ query, limit, ids }) => {
      const results = await stickerCache.searchStickers(query, limit);
      expect(results.map((entry) => entry.fileUniqueId)).toEqual(ids);
    });
  });

  it("returns count 0 when cache is empty", async () => {
    expect(await stickerCache.getCacheStats()).toEqual({ count: 0 });
  });

  it("returns correct stats with cached stickers", async () => {
    for (const [fileId, day] of [
      ["old", "20"],
      ["new", "26"],
      ["mid", "23"],
    ] as const) {
      await stickerCache.cacheSticker(
        sticker(fileId, { cachedAt: `2026-01-${day}T10:00:00.000Z` }),
      );
    }

    expect(await stickerCache.getCacheStats()).toEqual({
      count: 3,
      oldestAt: "2026-01-20T10:00:00.000Z",
      newestAt: "2026-01-26T10:00:00.000Z",
    });
  });
});
