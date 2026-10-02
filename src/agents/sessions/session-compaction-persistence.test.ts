import { expect, it, vi } from "vitest";
import {
  getSessionCompactionPersistence,
  withSessionCompactionPersistence,
  type CompactionAppendPersistence,
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
