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
import {
  TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  TELEGRAM_STICKER_CACHE_NAMESPACE,
} from "./sticker-cache-store.legacy-state.js";

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
        namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
        maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
      }),
    );
    await store.clear();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  describe("getCachedSticker", () => {
    it("returns null for unknown ID", async () => {
      const result = await stickerCache.getCachedSticker("unknown-id");
      expect(result).toBeNull();
    });

    it("returns cached sticker after cacheSticker", async () => {
      const sticker = {
        fileId: "file123",
        fileUniqueId: "unique123",
        emoji: "🎉",
        setName: "TestPack",
        description: "A party popper emoji sticker",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      await stickerCache.cacheSticker(sticker);
      const result = await stickerCache.getCachedSticker("unique123");

      expect(result).toEqual(sticker);
    });

    it("returns null after backing store is cleared", async () => {
      const sticker = {
        fileId: "file123",
        fileUniqueId: "unique123",
        description: "test",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      await stickerCache.cacheSticker(sticker);
      const cachedSticker = await stickerCache.getCachedSticker("unique123");
      if (!cachedSticker) {
        throw new Error("expected cached Telegram sticker");
      }
      expect(cachedSticker.fileUniqueId).toBe("unique123");

      await store.clear();

      expect(await stickerCache.getCachedSticker("unique123")).toBeNull();
    });

    it("treats plugin-state lookup failures as cache misses", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests("telegram", {
          namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
          maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
        }),
        async lookup() {
          await Promise.resolve();
          throw new Error("lookup failed");
        },
      });

      expect(await stickerCache.getCachedSticker("unique123")).toBeNull();
    });
  });

  describe("cacheSticker", () => {
    it("adds entry to cache", async () => {
      const sticker = {
        fileId: "file456",
        fileUniqueId: "unique456",
        description: "A cute fox waving",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      await stickerCache.cacheSticker(sticker);

      const all = await stickerCache.getAllCachedStickers();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(sticker);
    });

    it("omits undefined optional fields before storing", async () => {
      await stickerCache.cacheSticker({
        fileId: "file-undefined",
        fileUniqueId: "unique-undefined",
        emoji: undefined,
        setName: undefined,
        description: "Sticker with omitted fields",
        cachedAt: "2026-01-26T12:00:00.000Z",
        receivedFrom: undefined,
      });

      expect(await stickerCache.getCachedSticker("unique-undefined")).toStrictEqual({
        fileId: "file-undefined",
        fileUniqueId: "unique-undefined",
        description: "Sticker with omitted fields",
        cachedAt: "2026-01-26T12:00:00.000Z",
      });
    });

    it("updates existing entry", async () => {
      const original = {
        fileId: "file789",
        fileUniqueId: "unique789",
        description: "Original description",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };
      const updated = {
        fileId: "file789-new",
        fileUniqueId: "unique789",
        description: "Updated description",
        cachedAt: "2026-01-26T13:00:00.000Z",
      };

      await stickerCache.cacheSticker(original);
      await stickerCache.cacheSticker(updated);

      const result = await stickerCache.getCachedSticker("unique789");
      expect(result?.description).toBe("Updated description");
      expect(result?.fileId).toBe("file789-new");
    });

    it("settles only after the backing write commits", async () => {
      const backingStore = store;
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
        expect(await stickerCache.getCachedSticker(sticker.fileUniqueId)).toBeNull();
      } finally {
        release.resolve();
        await pending;
      }
      resetPluginStateStoreForTests();
      installStore(
        createPluginStateKeyedStoreForTests("telegram", {
          namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
          maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
        }),
      );
      expect(await stickerCache.getCachedSticker(sticker.fileUniqueId)).toEqual(sticker);
    });

    it("does not throw when plugin-state writes fail", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests("telegram", {
          namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
          maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
        }),
        async register() {
          await Promise.resolve();
          throw new Error("write failed");
        },
      });

      await expect(
        stickerCache.cacheSticker({
          fileId: "file-failure",
          fileUniqueId: "unique-failure",
          description: "Write failure should not block sticker handling",
          cachedAt: "2026-01-26T13:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
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

    it("ranks exact matches higher", async () => {
      // "waving" appears in "fox waving hello" - should be ranked first
      const results = await stickerCache.searchStickers("waving");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("fox-unique-1");
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

    it("returns no matches when plugin-state search reads fail", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests("telegram", {
          namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
          maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
        }),
        async entries() {
          await Promise.resolve();
          throw new Error("entries failed");
        },
      });

      expect(await stickerCache.searchStickers("fox")).toStrictEqual([]);
    });
  });

  describe("getAllCachedStickers", () => {
    it("returns empty array when cache is empty", async () => {
      const result = await stickerCache.getAllCachedStickers();
      expect(result).toStrictEqual([]);
    });

    it("returns empty array when plugin-state list reads fail", async () => {
      installStore({
        ...createPluginStateKeyedStoreForTests("telegram", {
          namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
          maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
        }),
        async entries() {
          await Promise.resolve();
          throw new Error("entries failed");
        },
      });

      expect(await stickerCache.getAllCachedStickers()).toStrictEqual([]);
    });

    it("returns all cached stickers", async () => {
      await stickerCache.cacheSticker({
        fileId: "a",
        fileUniqueId: "a-unique",
        description: "Sticker A",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      await stickerCache.cacheSticker({
        fileId: "b",
        fileUniqueId: "b-unique",
        description: "Sticker B",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });

      const result = await stickerCache.getAllCachedStickers();
      expect(result).toHaveLength(2);
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
