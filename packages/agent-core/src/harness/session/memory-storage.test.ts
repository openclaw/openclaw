// Agent Core tests cover memory storage behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeEntry } from "../types.js";
import { InMemorySessionStorage } from "./memory-storage.js";
import { Session } from "./session.js";

const rootEntry: SessionTreeEntry = {
  type: "custom",
  id: "root",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType: "root",
};

const childEntry: SessionTreeEntry = {
  type: "custom",
  id: "child",
  parentId: "root",
  timestamp: "2026-01-01T00:00:01.000Z",
  customType: "child",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InMemorySessionStorage", () => {
  it.each([32, 128])("keeps %i rapid short entry ids unique", async (count) => {
    let randomValue = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
          bytes.byteLength - 4,
          randomValue++,
        );
        return bytes;
      },
    });
    const storage = new InMemorySessionStorage();

    const ids = await Promise.all(Array.from({ length: count }, () => storage.createEntryId()));

    expect(ids.every((id) => id.length === 8)).toBe(true);
    expect(new Set(ids).size).toBe(count);
  });

  it("uses shared entry indexes for labels, leaves, and paths", async () => {
    const storage = new InMemorySessionStorage({
      entries: [
        rootEntry,
        childEntry,
        {
          type: "label",
          id: "label-1",
          parentId: "child",
          timestamp: "2026-01-01T00:00:02.000Z",
          targetId: "child",
          label: " latest ",
        },
      ],
    });

    expect(await storage.getLeafId()).toBe("label-1");
    expect(await storage.getLabel("child")).toBe("latest");
    expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual([
      "root",
      "child",
    ]);
  });

  it("records explicit leaf updates through the shared storage path", async () => {
    const storage = new InMemorySessionStorage({
      entries: [rootEntry, childEntry],
    });

    await storage.setLeafId("root");

    const entries = await storage.getEntries();
    const leaf = entries.at(-1);
    expect(await storage.getLeafId()).toBe("root");
    expect(leaf).toMatchObject({
      type: "leaf",
      parentId: "child",
      targetId: "root",
    });
  });

  it("returns a selected branch in root-to-leaf order", async () => {
    const activeLeaf: SessionTreeEntry = {
      type: "custom",
      id: "active-leaf",
      parentId: "child",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "active",
    };
    const sideLeaf: SessionTreeEntry = {
      type: "custom",
      id: "side-leaf",
      parentId: "root",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "side",
    };
    const storage = new InMemorySessionStorage({
      entries: [rootEntry, childEntry, activeLeaf, sideLeaf],
    });

    expect((await storage.getPathToRoot(activeLeaf.id)).map((entry) => entry.id)).toEqual([
      "root",
      "child",
      "active-leaf",
    ]);
    expect((await storage.getPathToRoot(sideLeaf.id)).map((entry) => entry.id)).toEqual([
      "root",
      "side-leaf",
    ]);
  });

  it("normalizes session names to one line", async () => {
    const session = new Session(new InMemorySessionStorage());

    await session.appendSessionName("  first\nsecond\r\nthird  ");

    expect(await session.getSessionName()).toBe("first second third");
  });

  it("traverses descendants of leaf markers through the selected target", async () => {
    const leafEntry: SessionTreeEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: "child",
      timestamp: "2026-01-01T00:00:02.000Z",
      targetId: "root",
    };
    const replacementEntry: SessionTreeEntry = {
      type: "custom",
      id: "replacement",
      parentId: leafEntry.id,
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "replacement",
    };
    const storage = new InMemorySessionStorage({
      entries: [rootEntry, childEntry, leafEntry, replacementEntry],
    });

    expect((await storage.getPathToRoot(replacementEntry.id)).map((entry) => entry.id)).toEqual([
      "root",
      "replacement",
    ]);
    expect((await storage.getPathToRoot(leafEntry.id)).map((entry) => entry.id)).toEqual(["root"]);
  });

  it("honors an explicit root append parent after a visible leaf selection", async () => {
    const storage = new InMemorySessionStorage({
      entries: [
        rootEntry,
        {
          type: "leaf",
          id: "leaf-1",
          parentId: "root",
          timestamp: "2026-01-01T00:00:01.000Z",
          targetId: "root",
          appendParentId: null,
        },
      ],
    });
    const session = new Session(storage);

    const entryId = await session.appendCustomEntry("new-root");

    expect(await session.getEntry(entryId)).toMatchObject({ parentId: null });
    expect((await storage.getPathToRoot(entryId)).map((entry) => entry.id)).toEqual([
      "root",
      entryId,
    ]);
  });

  it("keeps marked side ancestry separate from the next active append", async () => {
    const sideOne: SessionTreeEntry = {
      type: "custom",
      id: "side-one",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "side",
    };
    const sideTwo: SessionTreeEntry = {
      type: "custom",
      id: "side-two",
      parentId: sideOne.id,
      timestamp: "2026-01-01T00:00:03.000Z",
      appendMode: "side",
      customType: "side",
    };
    const storage = new InMemorySessionStorage({
      entries: [
        rootEntry,
        sideOne,
        {
          type: "leaf",
          id: "first-leaf",
          parentId: sideOne.id,
          timestamp: "2026-01-01T00:00:02.000Z",
          targetId: "root",
          appendParentId: sideOne.id,
          appendMode: "side",
        },
        sideTwo,
      ],
    });
    const session = new Session(storage);

    expect(await storage.getLeafId()).toBe("root");
    expect(await storage.getAppendParentId()).toBe(sideTwo.id);
    expect((await storage.getPathToRoot(sideTwo.id)).map((entry) => entry.id)).toEqual([
      "root",
      sideOne.id,
      sideTwo.id,
    ]);

    const nextEntryId = await session.appendCustomEntry("active");
    expect((await storage.getPathToRoot(nextEntryId)).map((entry) => entry.id)).toEqual([
      "root",
      nextEntryId,
    ]);
  });

  it("rejects a leaf entry with a missing append parent before recording it", async () => {
    const storage = new InMemorySessionStorage({ entries: [rootEntry] });

    await expect(
      storage.appendEntry({
        type: "leaf",
        id: "leaf-1",
        parentId: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        targetId: "root",
        appendParentId: "missing",
      }),
    ).rejects.toThrow("Append parent missing not found");
    expect(await storage.getEntries()).toEqual([rootEntry]);
  });
});
