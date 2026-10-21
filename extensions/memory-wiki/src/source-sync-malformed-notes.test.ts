import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryWikiSourceSyncStateStore,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const tempDirs = createMemoryWikiTestHarness();

async function createPage(group: MemoryWikiImportedSourceGroup, content: string, notes: string) {
  const stateDir = await tempDirs.createTempDir("memory-wiki-malformed-notes-");
  const vaultRoot = path.join(stateDir, "vault");
  const pagePath = "sources/page.md";
  const pageAbsPath = path.join(vaultRoot, pagePath);
  const title = group === "bridge" ? "Memory Bridge (test)" : "Unsafe Local Import: test";
  const pageContent = `# ${title}\n## Content\n\`\`\`\n${content}\n\`\`\`\n## Notes\n${notes}\n`;
  await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
  await fs.writeFile(pageAbsPath, pageContent, "utf8");
  const entry = {
    group,
    pagePath,
    sourcePath: "/tmp/source.md",
    sourceUpdatedAtMs: 0,
    sourceSize: 0,
    renderFingerprint: "fp",
  };
  const initialState = { version: 1 as const, entries: { "sync-key": entry } };
  return {
    stateDir,
    vaultRoot,
    pageAbsPath,
    pageContent,
    initialState,
    prune: (state: Parameters<typeof pruneImportedSourceEntries>[0]["state"] = initialState) =>
      pruneImportedSourceEntries({ vaultRoot, group, activeKeys: new Set(), state }),
  };
}

describe("memory wiki source sync malformed human Notes", () => {
  beforeEach(() => resetPluginStateStoreForTests());
  afterEach(() => resetPluginStateStoreForTests());

  it.each([
    ["bridge", "opening", "", "<!-- openclaw:human:end -->"],
    ["bridge", "closing", "<!-- openclaw:human:start -->", ""],
    ["unsafe-local", "both", "", ""],
  ] as const)(
    "preserves %s pages and persisted state when the %s marker is missing",
    async (group, missingMarker, start, end) => {
      const notes = [start, "human annotations must survive malformed markers", end]
        .filter(Boolean)
        .join("\n");
      const { stateDir, vaultRoot, pageAbsPath, pageContent, initialState, prune } =
        await createPage(group, "generated content", notes);

      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const store = createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
      );
      await writeMemoryWikiSourceSyncState(vaultRoot, initialState, store);
      const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
      const entry = state.entries["sync-key"]!;
      const updatedEntry = { ...entry, sourceSize: entry.sourceSize + 1 };
      setImportedSourceEntry({ state, syncKey: "sync-key", entry: updatedEntry });
      const expectedMissingMarker =
        missingMarker === "closing"
          ? "<!-- openclaw:human:end -->"
          : "<!-- openclaw:human:start -->";

      await expect(prune(state)).rejects.toThrow(expectedMissingMarker);

      expect(state.entries["sync-key"]).toEqual(updatedEntry);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual(initialState);
      await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toBe(pageContent);
      await expect(fs.access(path.join(vaultRoot, ".salvage"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeMemoryWikiSourceSyncState(vaultRoot, state, store);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toMatchObject({
        entries: { "sync-key": updatedEntry },
      });
    },
  );

  it("rejects pruning an oversized source page with an unclosed human Notes marker", async () => {
    const { vaultRoot, pageAbsPath, initialState, prune } = await createPage(
      "bridge",
      "x".repeat(16 * 1024 * 1024),
      "<!-- openclaw:human:start -->\noversized annotations must survive malformed markers",
    );

    await expect(prune()).rejects.toThrow("<!-- openclaw:human:end -->");

    expect(initialState.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isFile());
    await expect(fs.access(path.join(vaultRoot, ".salvage"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
