import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { FileEntry } from "./session-manager.js";

const { statSyncMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  statSync: statSyncMock,
}));

import {
  sessionEntriesCache,
  tryReadCachedSessionEntries,
} from "./session-manager-cache-internal.js";

beforeEach(() => {
  sessionEntriesCache.clear();
  statSyncMock.mockReset();
});

it("returns cache misses without synchronously stating the file", () => {
  expect(tryReadCachedSessionEntries("/tmp/not-cached.jsonl")).toBeUndefined();
  expect(statSyncMock).not.toHaveBeenCalled();
});

const snapshot = {
  dev: 1n,
  ino: 2n,
  size: 100n,
  mtimeNs: 3n,
  ctimeNs: 4n,
};

function seedCache(filePath: string): FileEntry[] {
  const entries: FileEntry[] = [
    {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-07-10T00:00:00.000Z",
      cwd: "/tmp",
    },
  ];
  sessionEntriesCache.set(resolve(filePath), {
    snapshot,
    entries,
    endsWithNewline: true,
  });
  return entries;
}

it("returns a detached entry-list snapshot", () => {
  const filePath = "/tmp/cached.jsonl";
  const cachedEntries = seedCache(filePath);
  statSyncMock.mockReturnValue(snapshot);

  const firstRead = tryReadCachedSessionEntries(filePath);
  expect(firstRead).toEqual(cachedEntries);
  expect(firstRead).not.toBe(cachedEntries);

  (firstRead as FileEntry[]).length = 0;
  expect(tryReadCachedSessionEntries(filePath)).toEqual(cachedEntries);
});

it("invalidates a same-size cache hit changed between snapshot checks", () => {
  const filePath = "/tmp/concurrently-replaced.jsonl";
  seedCache(filePath);
  statSyncMock
    .mockReturnValueOnce(snapshot)
    .mockReturnValueOnce({ ...snapshot, mtimeNs: 5n, ctimeNs: 6n });

  expect(tryReadCachedSessionEntries(filePath)).toBeUndefined();
  expect(sessionEntriesCache.has(resolve(filePath))).toBe(false);
});
