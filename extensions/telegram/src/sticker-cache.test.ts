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
    installStore(
      createPluginStateKeyedStoreForTests("telegram", {
        namespace: "telegram.sticker-cache",
        maxEntries: 10_000,
      }),
    );
    await store.clear();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it.each([
    {
      operation: "lookup",
      run: () => stickerCache.getCachedSticker("unavailable-sticker"),
      fallback: null,
    },
    {
      operation: "register",
      run: () =>
        stickerCache.cacheSticker({
          fileId: "file-failure",
          fileUniqueId: "unique-failure",
          description: "Write failure should not block sticker handling",
          cachedAt: "2026-01-26T13:00:00.000Z",
        }),
      fallback: undefined,
    },
    {
      operation: "entries",
      run: () => stickerCache.searchStickers("fox"),
      fallback: [],
    },
  ])(
    "returns the best-effort fallback when plugin-state $operation rejects",
    async ({ operation, run, fallback }) => {
      installStore({
        ...store,
        async [operation]() {
          await Promise.resolve();
          throw new Error(`${operation} failed`);
        },
      });
      await expect(run()).resolves.toStrictEqual(fallback);
    },
  );

  describe("cacheSticker", () => {
    it("settles only after the backing write commits", async () => {
      const backingStore = store;
      await stickerCache.cacheSticker({
        fileId: "original-file",
        fileUniqueId: "delayed-unique",
        description: "Original sticker",
        setName: "OriginalSet",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });
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
      const sticker = {
        fileId: "delayed-file",
        fileUniqueId: "delayed-unique",
        emoji: undefined,
        setName: undefined,
        receivedFrom: undefined,
        description: "A delayed sticker",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };
      let settled = false;
      const pending = stickerCache.cacheSticker(sticker).then(() => {
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
      installStore(
        createPluginStateKeyedStoreForTests("telegram", {
          namespace: "telegram.sticker-cache",
          maxEntries: 10_000,
        }),
      );
      expect(await stickerCache.getCachedSticker("delayed-unique")).toStrictEqual({
        fileId: "delayed-file",
        fileUniqueId: "delayed-unique",
        description: "A delayed sticker",
        cachedAt: "2026-01-26T12:00:00.000Z",
      });
    });
  });

  describe("searchStickers", () => {
    beforeEach(async () => {
      // Seed cache with test stickers
      await stickerCache.cacheSticker({
        fileId: "fox1",
        fileUniqueId: "fox-unique-1",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A cute orange fox waving hello",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "fox2",
        fileUniqueId: "fox-unique-2",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A fox sleeping peacefully",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "cat1",
        fileUniqueId: "cat-unique-1",
        emoji: "🐱",
        setName: "FunnyCats",
        description: "A cat sitting on a keyboard",
        cachedAt: "2026-01-26T12:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "dog1",
        fileUniqueId: "dog-unique-1",
        emoji: "🐶",
        setName: "GoodBoys",
        description: "A golden retriever playing fetch",
        cachedAt: "2026-01-26T13:00:00.000Z",
      });
    });

    it("finds stickers by description substring", async () => {
      const results = await stickerCache.searchStickers("fox");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("finds stickers by emoji", async () => {
      const results = await stickerCache.searchStickers("🦊");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("finds stickers by set name", async () => {
      const results = await stickerCache.searchStickers("CuteFoxes");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("respects limit parameter", async () => {
      const results = await stickerCache.searchStickers("fox", 1);
      expect(results).toHaveLength(1);
    });

    it("returns empty array for no matches", async () => {
      const results = await stickerCache.searchStickers("elephant");
      expect(results).toHaveLength(0);
    });

    it("is case insensitive", async () => {
      const results = await stickerCache.searchStickers("FOX");
      expect(results).toHaveLength(2);
    });

    it("matches multiple words", async () => {
      const results = await stickerCache.searchStickers("cat keyboard");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("cat-unique-1");
    });
  });

  describe("getCacheStats", () => {
    it("returns count 0 when cache is empty", async () => {
      const stats = await stickerCache.getCacheStats();
      expect(stats.count).toBe(0);
      expect(stats.oldestAt).toBeUndefined();
      expect(stats.newestAt).toBeUndefined();
    });

    it("returns correct stats with cached stickers", async () => {
      await stickerCache.cacheSticker({
        fileId: "old",
        fileUniqueId: "old-unique",
        description: "Old sticker",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "new",
        fileUniqueId: "new-unique",
        description: "New sticker",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "mid",
        fileUniqueId: "mid-unique",
        description: "Middle sticker",
        cachedAt: "2026-01-23T10:00:00.000Z",
      });

      const stats = await stickerCache.getCacheStats();
      expect(stats.count).toBe(3);
      expect(stats.oldestAt).toBe("2026-01-20T10:00:00.000Z");
      expect(stats.newestAt).toBe("2026-01-26T10:00:00.000Z");
    });
  });
});
