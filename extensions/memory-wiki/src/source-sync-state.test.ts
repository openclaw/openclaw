import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
  type MemoryWikiImportedSourceState,
} from "./source-sync-state.js";
import { createMemoryKeyedStore, createMemoryWikiTestHarness } from "./test-helpers.js";

const tempDirs = createMemoryWikiTestHarness();

function createImportedSourceState(pagePath: string, group: "bridge" | "unsafe-local" = "bridge") {
  return {
    version: 1 as const,
    entries: {
      "sync-key": {
        group,
        pagePath,
        sourcePath: "/tmp/source.md",
        sourceUpdatedAtMs: 0,
        sourceSize: 0,
        renderFingerprint: "fp",
      },
    },
  };
}

function renderNotes(notes: string) {
  return `## Notes\n<!-- openclaw:human:start -->\n${notes ? `${notes}\n` : ""}<!-- openclaw:human:end -->\n`;
}

function renderSourcePage(
  notes: string,
  content = "generated content",
  bridgeSource = false,
  language = "",
) {
  const header = "# Memory Bridge (test)\n" + (bridgeSource ? "## Bridge Source\n" : "");
  return `${header}## Content\n\`\`\`${language}\n${content}\n\`\`\`\n${renderNotes(notes)}`;
}

function expectMissing(read: Promise<unknown>) {
  return expect(read).rejects.toMatchObject({ code: "ENOENT" });
}

function prune(
  vaultRoot: string,
  state: MemoryWikiImportedSourceState,
  group: "bridge" | "unsafe-local" = "bridge",
) {
  return pruneImportedSourceEntries({ vaultRoot, group, activeKeys: new Set(), state });
}

async function createSourceFixture(
  content?: string,
  group: "bridge" | "unsafe-local" = "bridge",
  pagePath = "sources/page.md",
) {
  const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
  const pageAbsPath = path.join(vaultRoot, pagePath);
  await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
  if (content !== undefined) {
    await fs.writeFile(pageAbsPath, content, "utf8");
  }
  const state = createImportedSourceState(pagePath, group);
  return {
    vaultRoot,
    pageAbsPath,
    state,
    prunePage: () => prune(vaultRoot, state, group),
    read: () => fs.readFile(pageAbsPath, "utf8"),
    salvage: () =>
      fs.readFile(
        path.join(vaultRoot, ".salvage", `${pagePath.replaceAll("/", "_")}.notes.md`),
        "utf8",
      ),
  };
}

function makeEntry(index: number) {
  return {
    group: "bridge" as const,
    pagePath: `sources/source-${index}.md`,
    sourcePath: `/tmp/source-${index}.md`,
    sourceUpdatedAtMs: index,
    sourceSize: index,
    renderFingerprint: `fingerprint-${index}`,
  };
}

function createCountingStore(options?: { maxEntries?: number }) {
  const values = new Map<string, unknown>();
  const calls = { register: 0, delete: 0, entries: 0 };
  let openOptions: OpenKeyedStoreOptions | undefined;
  const openKeyedStore = <T>(storeOptions: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
    openOptions = storeOptions;
    const store = createMemoryKeyedStore<T>(values);
    return {
      ...store,
      register(key, value) {
        calls.register += 1;
        if (!values.has(key) && options?.maxEntries && values.size >= options.maxEntries) {
          const oldestKey = values.keys().next().value;
          if (oldestKey) {
            values.delete(oldestKey);
          }
        }
        return store.register(key, value);
      },
      delete(key) {
        calls.delete += 1;
        return store.delete(key);
      },
      entries() {
        calls.entries += 1;
        return store.entries();
      },
    };
  };
  return {
    store: createMemoryWikiSourceSyncStateStore(openKeyedStore),
    calls,
    get openOptions() {
      return openOptions;
    },
    resetCalls() {
      Object.assign(calls, { register: 0, delete: 0, entries: 0 });
    },
  };
}

describe("memory wiki source sync state", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(() => {
    configureMemoryWikiSourceSyncStateStore(undefined);
    resetPluginStateStoreForTests();
  });

  it("persists only changed rows in a 1,914-entry state snapshot", async () => {
    const vaultRoot = path.join(await tempDirs.createTempDir("memory-wiki-source-sync-"), "vault");
    const counting = createCountingStore();
    const entries = Object.fromEntries(
      Array.from({ length: 1_914 }, (_, index) => [`source-${index}`, makeEntry(index)]),
    );
    await writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries }, counting.store);
    expect(counting.openOptions?.overflowPolicy).toBe("reject-new");

    const state = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    counting.resetCalls();
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 0, delete: 0, entries: 0 });

    const changed = state.entries["source-0"];
    expect(changed).toBeDefined();
    setImportedSourceEntry({
      state,
      syncKey: "source-0",
      entry: { ...changed!, sourceSize: changed!.sourceSize + 1 },
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 1, delete: 0, entries: 0 });

    counting.resetCalls();
    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(Object.keys(state.entries).filter((key) => key !== "source-1")),
      state,
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 0, delete: 1, entries: 0 });

    const persisted = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    expect(persisted.entries["source-0"]?.sourceSize).toBe(1);
    expect(persisted.entries["source-1"]).toBeUndefined();
    expect(Object.keys(persisted.entries)).toHaveLength(1_913);
  });

  it("deletes replaced rows before upserts at the store capacity", async () => {
    const vaultRoot = path.join(await tempDirs.createTempDir("memory-wiki-source-sync-"), "vault");
    const counting = createCountingStore({ maxEntries: 2 });
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: { "source-0": makeEntry(0), "source-1": makeEntry(1) },
      },
      counting.store,
    );

    const tracked = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(["source-0"]),
      state: tracked,
    });
    setImportedSourceEntry({
      state: tracked,
      syncKey: "source-2",
      entry: makeEntry(2),
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, tracked, counting.store);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, counting.store)).resolves.toMatchObject({
      entries: { "source-0": makeEntry(0), "source-2": makeEntry(2) },
    });

    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: { "source-0": makeEntry(0), "source-3": makeEntry(3) },
      },
      counting.store,
    );
    await expect(readMemoryWikiSourceSyncState(vaultRoot, counting.store)).resolves.toMatchObject({
      entries: { "source-0": makeEntry(0), "source-3": makeEntry(3) },
    });
  });

  it("ignores retired JSON when reading current source-sync state", async () => {
    const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const legacyPath = path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "retired JSON is not a runtime input\n");

    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {},
    });
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe(
      "retired JSON is not a runtime input\n",
    );
  });

  it("preserves previous Notes when a long source page is pruned again", async () => {
    const pagePath = `sources/repeated-${"a".repeat(180)}.md`;
    const { vaultRoot, pageAbsPath } = await createSourceFixture(undefined, "bridge", pagePath);
    const annotations = ["first durable annotation", "second durable annotation"];

    for (const annotation of annotations) {
      await fs.writeFile(
        pageAbsPath,
        renderSourcePage(annotation, "generated content", true),
        "utf-8",
      );

      await expect(prune(vaultRoot, createImportedSourceState(pagePath))).resolves.toBe(1);
    }

    const salvageDir = path.join(vaultRoot, ".salvage");
    const salvageFiles = await fs.readdir(salvageDir);
    expect(salvageFiles).toHaveLength(2);
    const salvagedNotes = await Promise.all(
      salvageFiles.map((file) => fs.readFile(path.join(salvageDir, file), "utf-8")),
    );
    for (const annotation of annotations) {
      expect(salvagedNotes.some((notes) => notes.includes(annotation))).toBe(true);
    }
  });

  it("keeps a replaced source page without following its symlink", async () => {
    const externalRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const { vaultRoot, pageAbsPath, state, prunePage } = await createSourceFixture();
    const externalPath = path.join(externalRoot, "private-notes.md");
    await fs.writeFile(externalPath, "external human Notes must not be read\n", "utf-8");
    await fs.symlink(externalPath, pageAbsPath);
    await expect(prunePage()).resolves.toBe(0);
    expect((await fs.lstat(pageAbsPath)).isSymbolicLink()).toBe(true);
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.readFile(externalPath, "utf-8")).resolves.toBe(
      "external human Notes must not be read\n",
    );
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it.each([
    { group: "bridge" as const, generatedBytes: 0 },
    { group: "unsafe-local" as const, generatedBytes: 17 * 1024 * 1024 },
  ])(
    "keeps $group Notes byte-for-byte when pruning cannot decode the page",
    async ({ group, generatedBytes }) => {
      const { vaultRoot, pageAbsPath, state, prunePage, salvage } = await createSourceFixture(
        undefined,
        group,
      );
      const notes = "durable annotation: Café 🤖 � original";
      let validPage = Buffer.from(renderSourcePage(notes, "x".repeat(generatedBytes)));
      if (generatedBytes > 0) {
        // A valid code point crosses the bounded recovery header/stream boundary.
        const splitAt = 64 * 1024 - 1;
        validPage = Buffer.concat([
          validPage.subarray(0, splitAt),
          Buffer.from("🤖"),
          validPage.subarray(splitAt),
        ]);
      }
      const invalidPage = Buffer.from(validPage);
      const notesOffset = invalidPage.indexOf(Buffer.from("Café"));
      expect(notesOffset).toBeGreaterThan(0);
      invalidPage[notesOffset] = 0xff;
      await fs.writeFile(pageAbsPath, invalidPage);
      const entry = state.entries["sync-key"];

      await expect(prunePage()).resolves.toBe(0);
      expect((await fs.readFile(pageAbsPath)).equals(invalidPage)).toBe(true);
      expect(state.entries["sync-key"]).toBe(entry);
      await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));

      await fs.writeFile(pageAbsPath, validPage);
      await expect(prunePage()).resolves.toBe(1);
      expect(state.entries["sync-key"]).toBeUndefined();
      await expectMissing(fs.access(pageAbsPath));
      await expect(salvage()).resolves.toContain(notes);
    },
  );

  it("salvages Notes and prunes oversized source pages with bounded reads", async () => {
    const { pageAbsPath, state, prunePage, salvage } = await createSourceFixture(
      renderSourcePage(
        "oversized annotations must survive",
        renderNotes("generated content, not durable annotations") + "x".repeat(16 * 1024 * 1024),
        false,
        "markdown",
      ),
    );
    await expect(prunePage()).resolves.toBe(1);
    expect(state.entries["sync-key"]).toBeUndefined();
    await expectMissing(fs.stat(pageAbsPath));
    const recoveredNotes = await salvage();
    expect(recoveredNotes).toContain("oversized annotations must survive");
    expect(recoveredNotes).not.toContain("generated content, not durable annotations");
  });

  it("prunes oversized generated pages without creating empty Notes recoveries", async () => {
    const { vaultRoot, pageAbsPath, state, prunePage } = await createSourceFixture(
      renderSourcePage("", "x".repeat(16 * 1024 * 1024)),
      "unsafe-local",
    );
    await expect(prunePage()).resolves.toBe(1);
    expect(state.entries["sync-key"]).toBeUndefined();
    await expectMissing(fs.stat(pageAbsPath));
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it("does not mistake a fence inside oversized human Notes for the source boundary", async () => {
    const { vaultRoot, pageAbsPath, state, prunePage } = await createSourceFixture(
      renderSourcePage(
        "n".repeat(16 * 1024 * 1024) +
          "\n```\n" +
          renderNotes("this boundary-shaped fence belongs to the human annotation").trimEnd(),
        "s".repeat(1024 * 1024),
        false,
        "markdown",
      ),
      "unsafe-local",
    );
    await expect(prunePage()).resolves.toBe(0);
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isFile());
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it("restores malformed oversized pages after a bounded recovery scan", async () => {
    const { pageAbsPath, state, prunePage } = await createSourceFixture(
      ["# Memory Bridge (test)", "## Content", "```markdown", "missing closing fence"].join("\n"),
      "unsafe-local",
    );
    await fs.truncate(pageAbsPath, 33 * 1024 * 1024);
    await expect(prunePage()).resolves.toBe(0);
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toMatchObject({ size: 33 * 1024 * 1024 });
    await expect(fs.readdir(path.dirname(pageAbsPath))).resolves.toEqual(["page.md"]);
  });

  it("does not duplicate unchanged recovered Notes on repeated prunes", async () => {
    const { vaultRoot, pageAbsPath } = await createSourceFixture();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fs.writeFile(pageAbsPath, renderSourcePage("recovery must remain idempotent"), "utf-8");
      await expect(prune(vaultRoot, createImportedSourceState("sources/page.md"))).resolves.toBe(1);
    }

    expect(await fs.readdir(path.join(vaultRoot, ".salvage"))).toHaveLength(1);
  });

  it("does not create salvage files for pages without human Notes", async () => {
    const { vaultRoot, prunePage } = await createSourceFixture(
      "# Memory Bridge\n\n## Content\n\nNo notes here.\n",
    );
    await prunePage();
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it("prunes pages even when the page file is already missing", async () => {
    const { pageAbsPath, prunePage } = await createSourceFixture();
    await expect(prunePage()).resolves.toBe(1);
    await expectMissing(fs.access(pageAbsPath));
  });

  it("keeps the page when salvage write fails", async () => {
    const { vaultRoot, read, prunePage } = await createSourceFixture(
      renderSourcePage("must survive", "generated"),
    );

    // A file at the recovery-directory path must fail closed without deleting Notes.
    await fs.writeFile(path.join(vaultRoot, ".salvage"), "block", "utf-8");

    await expect(prunePage()).resolves.toBe(0);
    await expect(read()).resolves.toContain("must survive");
  });

  it("rejects projected imports that would exceed the source-sync row cap", () => {
    expect(() =>
      assertMemoryWikiSourceSyncStateCapacity({
        state: createImportedSourceState("sources/retained.md", "unsafe-local"),
        group: "bridge",
        incomingCount: 20_000,
      }),
    ).toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });

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
      const title = group === "bridge" ? "Memory Bridge (test)" : "Unsafe Local Import: test";
      const pageContent = `# ${title}\n## Content\n\`\`\`\ngenerated content\n\`\`\`\n## Notes\n${notes}\n`;
      const {
        vaultRoot,
        pageAbsPath,
        state: initialState,
      } = await createSourceFixture(pageContent, group);
      const env = { ...process.env, OPENCLAW_STATE_DIR: vaultRoot };
      const store = createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
      );
      await writeMemoryWikiSourceSyncState(vaultRoot, initialState, store);
      const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
      const entry = state.entries["sync-key"]!;
      const updatedEntry = { ...entry, sourceSize: entry.sourceSize + 1 };
      setImportedSourceEntry({ state, syncKey: "sync-key", entry: updatedEntry });
      const marker = missingMarker === "closing" ? "end" : "start";

      await expect(prune(vaultRoot, state, group)).rejects.toThrow(
        `<!-- openclaw:human:${marker} -->`,
      );
      expect(state.entries["sync-key"]).toEqual(updatedEntry);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual(initialState);
      await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toBe(pageContent);
      await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
      await writeMemoryWikiSourceSyncState(vaultRoot, state, store);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toMatchObject({
        entries: { "sync-key": updatedEntry },
      });
    },
  );

  it("rejects pruning an oversized source page with an unclosed human Notes marker", async () => {
    const pageContent = `# Memory Bridge (test)\n## Content\n\`\`\`\n${"x".repeat(16 * 1024 * 1024)}\n\`\`\`\n## Notes\n<!-- openclaw:human:start -->\noversized annotations must survive malformed markers\n`;
    const { vaultRoot, pageAbsPath, state, prunePage } = await createSourceFixture(pageContent);
    await expect(prunePage()).rejects.toThrow("<!-- openclaw:human:end -->");
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isFile());
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });
});
