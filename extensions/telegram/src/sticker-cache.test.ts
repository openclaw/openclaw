import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { useTelegramKeyedState } from "./keyed-state.test-support.js";
import * as stickerCache from "./sticker-cache-store.js";

describe("sticker-cache", () => {
  type StickerEntry = stickerCache.CachedSticker;
  const fixture = useTelegramKeyedState<StickerEntry>({
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

  it("returns the best-effort fallback when plugin-state register rejects", async () => {
    fixture.install({
      ...fixture.store,
      async register() {
        await Promise.resolve();
        throw new Error("register failed");
      },
    });
    await expect(stickerCache.cacheSticker(sticker("file-failure"))).resolves.toBeUndefined();
  });

  it("settles only after the backing write commits", async () => {
    const backingStore = fixture.store;
    const original = sticker("original-file", {
      fileUniqueId: "delayed-unique",
      description: "Original sticker",
      setName: "OriginalSet",
      cachedAt: "2026-01-26T11:00:00.000Z",
    });
    const expected = sticker("delayed-file", {
      fileUniqueId: "delayed-unique",
      description: "A delayed sticker",
      cachedAt: "2026-01-26T12:00:00.000Z",
    });
    await stickerCache.cacheSticker(original);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.install({
      ...backingStore,
      async register(key, value, options) {
        entered.resolve();
        await release.promise;
        await backingStore.register(key, value, options);
      },
    });
    let settled = false;
    const pending = stickerCache
      .cacheSticker({ ...expected, emoji: undefined, setName: undefined, receivedFrom: undefined })
      .then(() => {
        settled = true;
      });
    try {
      await entered.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(await stickerCache.getCachedSticker("delayed-unique")).toMatchObject(original);
    } finally {
      release.resolve();
      await pending;
    }
    resetPluginStateStoreForTests();
    fixture.install(fixture.open());
    expect(await stickerCache.getCachedSticker("delayed-unique")).toStrictEqual(expected);
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
