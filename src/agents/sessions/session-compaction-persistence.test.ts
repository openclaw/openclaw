import { expect, it, vi } from "vitest";
import {
  getSessionCompactionPersistence,
  getSessionCompactionPersistenceAsync,
  withSessionCompactionPersistence,
  withSessionCompactionPersistenceAsync,
  type CompactionAppendPersistence,
  type CompactionAppendPersistenceAsync,
} from "./session-compaction-persistence.js";

it("closes a compaction invocation before its deferred descendants run", async () => {
  const manager = {};
  const persist = vi.fn<CompactionAppendPersistence>();
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
  expect(persist).not.toHaveBeenCalled();
});

it("retains an awaited compaction invocation and revokes deferred descendants on rejection", async () => {
  const manager = {};
  const persist = vi.fn<CompactionAppendPersistenceAsync>();
  const failure = new Error("worker rejected compaction");
  let releaseDescendant!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseDescendant = resolve;
  });
  let descendant: Promise<CompactionAppendPersistenceAsync | undefined> | undefined;
  await expect(
    withSessionCompactionPersistenceAsync(manager, persist, async () => {
      await Promise.resolve();
      expect(getSessionCompactionPersistenceAsync(manager)).toBe(persist);
      expect(getSessionCompactionPersistenceAsync({})).toBeUndefined();
      descendant = released.then(() => getSessionCompactionPersistenceAsync(manager));
      throw failure;
    }),
  ).rejects.toBe(failure);
  releaseDescendant();
  await expect(descendant).resolves.toBeUndefined();
  expect(getSessionCompactionPersistenceAsync(manager)).toBeUndefined();
});
