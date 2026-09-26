import { expect, it, vi } from "vitest";
import {
  getSessionCompactionPersistence,
  withSessionCompactionPersistence,
  withSessionCompactionPersistenceAsync,
  type CompactionAppendPersistence,
} from "./session-compaction-persistence.js";

it("closes a compaction invocation before its deferred descendants run", async () => {
  const manager = {};
  const persist = { prepare: vi.fn(), assertActive: vi.fn(), onCommitted: vi.fn() };
  let descendant: Promise<CompactionAppendPersistence | undefined> | undefined;
  expect(
    withSessionCompactionPersistence(manager, persist, () => {
      expect(getSessionCompactionPersistence(manager)).toBe(persist);
      descendant = Promise.resolve().then(() => getSessionCompactionPersistence(manager));
      return "entry";
    }),
  ).toBe("entry");
  expect(getSessionCompactionPersistence(manager)).toBeUndefined();
  await expect(descendant).resolves.toBeUndefined();
  expect(persist.prepare).not.toHaveBeenCalled();
});

it("retains an asynchronous compaction owner through settlement and closes retained descendants", async () => {
  const manager = {};
  const persist = { prepare: vi.fn(), assertActive: vi.fn(), onCommitted: vi.fn() };
  const releaseDescendant = Promise.withResolvers<void>();
  let descendant: Promise<CompactionAppendPersistence | undefined> | undefined;
  await expect(
    withSessionCompactionPersistenceAsync(manager, persist, async () => {
      await Promise.resolve();
      expect(getSessionCompactionPersistence(manager)).toBe(persist);
      expect(getSessionCompactionPersistence({})).toBeUndefined();
      descendant = releaseDescendant.promise.then(() => getSessionCompactionPersistence(manager));
      throw new Error("append refused");
    }),
  ).rejects.toThrow("append refused");
  expect(getSessionCompactionPersistence(manager)).toBeUndefined();
  releaseDescendant.resolve();
  await expect(descendant).resolves.toBeUndefined();
});
