import { expect, it, vi } from "vitest";
import {
  getSessionCompactionPersistenceAsync,
  withSessionCompactionPersistenceAsync,
  type CompactionAppendPersistenceAsync,
} from "./session-compaction-persistence.js";

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
