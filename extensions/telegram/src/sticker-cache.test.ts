import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it } from "vitest";
import { useTelegramKeyedState } from "./keyed-state.test-support.js";
import * as stickerCache from "./sticker-cache-store.js";

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
      throw new Error("register failed");
    },
  });
  await expect(stickerCache.cacheSticker(sticker("file-failure"))).resolves.toBeUndefined();
});

it("settles only after the backing write commits", async () => {
  const backingStore = fixture.store;
  const expected = sticker("delayed-file");
  const original = {
    ...expected,
    fileId: "original-file",
    description: "Original sticker",
    cachedAt: "2026-01-26T11:00:00.000Z",
    setName: "OriginalSet",
  };
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
  const pending = stickerCache.cacheSticker({
    ...expected,
    emoji: undefined,
    setName: undefined,
    receivedFrom: undefined,
  });
  try {
    await entered.promise;
    expect(await Promise.race([pending.then(() => true), setImmediate(false)])).toBe(false);
    expect(await stickerCache.getCachedSticker(expected.fileUniqueId)).toMatchObject(original);
  } finally {
    release.resolve();
    await pending;
  }
  resetPluginStateStoreForTests();
  fixture.install(fixture.open());
  expect(await stickerCache.getCachedSticker(expected.fileUniqueId)).toStrictEqual(expected);
});

it.each([
  { query: "🦊", limit: undefined, ids: ["fox1-unique", "fox2-unique"] },
  { query: "FOX", limit: 1, ids: ["fox1-unique"] },
  { query: "Müller", limit: undefined, ids: ["mueller-unique"] },
])("finds $query with limit $limit", async ({ query, limit, ids }) => {
  for (const [fileId, emoji, setName, description] of [
    ["fox1", "🦊", "CuteFoxes", "A fox waving"],
    ["fox2", "🦊", "CuteFoxes", "A fox sleeping"],
    ["cat1", "🐱", "FunnyCats", "A cat sitting"],
    ["mueller", "🙂", "Faces", "Mu\u0308ller sticker"],
  ] as const) {
    await stickerCache.cacheSticker(sticker(fileId, { emoji, setName, description }));
  }
  const results = await stickerCache.searchStickers(query, limit);
  expect(results.map((entry) => entry.fileUniqueId)).toEqual(ids);
});

it("reports empty and populated cache stats with timestamp bounds", async () => {
  expect(await stickerCache.getCacheStats()).toEqual({ count: 0 });
  for (const day of [20, 26, 23]) {
    await stickerCache.cacheSticker(
      sticker(String(day), { cachedAt: `2026-01-${day}T10:00:00.000Z` }),
    );
  }

  expect(await stickerCache.getCacheStats()).toEqual({
    count: 3,
    oldestAt: "2026-01-20T10:00:00.000Z",
    newestAt: "2026-01-26T10:00:00.000Z",
  });
});
