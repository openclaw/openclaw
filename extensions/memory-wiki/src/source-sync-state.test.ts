import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
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
  state: ReturnType<typeof createImportedSourceState>,
  group: "bridge" | "unsafe-local" = "bridge",
) {
  return pruneImportedSourceEntries({ vaultRoot, group, activeKeys: new Set(), state });
}

async function createSourceFixture(pagePath: string) {
  const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
  const pageAbsPath = path.join(vaultRoot, pagePath);
  await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
  return { vaultRoot, pageAbsPath };
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
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    const annotations = ["first durable annotation", "second durable annotation"];

    for (const annotation of annotations) {
      await fs.writeFile(
        pageAbsPath,
        renderSourcePage(annotation, "generated content", true),
        "utf-8",
      );

      const removed = await prune(vaultRoot, createImportedSourceState(pagePath));

      expect(removed).toBe(1);
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
    const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const externalRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const pagePath = "sources/replaced-with-symlink.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    const externalPath = path.join(externalRoot, "private-notes.md");
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(externalPath, "external human Notes must not be read\n", "utf-8");
    await fs.symlink(externalPath, pageAbsPath);
    const state = createImportedSourceState(pagePath);

    const removed = await prune(vaultRoot, state);

    expect(removed).toBe(0);
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
      const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
      const pagePath = `sources/${group}-invalid-encoding.md`;
      const pageAbsPath = path.join(vaultRoot, pagePath);
      await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
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
      const state = createImportedSourceState(pagePath, group);
      const entry = state.entries["sync-key"];
      const prunePage = () =>
        pruneImportedSourceEntries({ vaultRoot, group, activeKeys: new Set<string>(), state });

      await expect(prunePage()).resolves.toBe(0);
      expect((await fs.readFile(pageAbsPath)).equals(invalidPage)).toBe(true);
      expect(state.entries["sync-key"]).toBe(entry);
      await expect(fs.access(path.join(vaultRoot, ".salvage"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await fs.writeFile(pageAbsPath, validPage);
      await expect(prunePage()).resolves.toBe(1);
      expect(state.entries["sync-key"]).toBeUndefined();
      await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.readFile(
          path.join(vaultRoot, ".salvage", `sources_${group}-invalid-encoding.md.notes.md`),
          "utf8",
        ),
      ).resolves.toContain(notes);
    },
  );

  it("salvages Notes and prunes oversized source pages with bounded reads", async () => {
    const pagePath = "sources/oversized-recovery.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(
      pageAbsPath,
      renderSourcePage(
        "oversized annotations must survive",
        renderNotes("generated content, not durable annotations") + "x".repeat(16 * 1024 * 1024),
        false,
        "markdown",
      ),
      "utf-8",
    );
    const state = createImportedSourceState(pagePath);

    await expect(prune(vaultRoot, state)).resolves.toBe(1);
    expect(state.entries["sync-key"]).toBeUndefined();
    await expectMissing(fs.stat(pageAbsPath));
    const recoveredNotes = await fs.readFile(
      path.join(vaultRoot, ".salvage", "sources_oversized-recovery.md.notes.md"),
      "utf8",
    );
    expect(recoveredNotes).toContain("oversized annotations must survive");
    expect(recoveredNotes).not.toContain("generated content, not durable annotations");
  });

  it("prunes oversized generated pages without creating empty Notes recoveries", async () => {
    const pagePath = "sources/oversized-empty-notes.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(pageAbsPath, renderSourcePage("", "x".repeat(16 * 1024 * 1024)), "utf8");
    const state = createImportedSourceState(pagePath, "unsafe-local");

    await expect(prune(vaultRoot, state, "unsafe-local")).resolves.toBe(1);
    expect(state.entries["sync-key"]).toBeUndefined();
    await expectMissing(fs.stat(pageAbsPath));
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it("does not mistake a fence inside oversized human Notes for the source boundary", async () => {
    const pagePath = "sources/oversized-human-notes-fence.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(
      pageAbsPath,
      renderSourcePage(
        "n".repeat(16 * 1024 * 1024) +
          "\n```\n" +
          renderNotes("this boundary-shaped fence belongs to the human annotation").trimEnd(),
        "s".repeat(1024 * 1024),
        false,
        "markdown",
      ),
      "utf8",
    );
    const state = createImportedSourceState(pagePath, "unsafe-local");

    await expect(prune(vaultRoot, state, "unsafe-local")).resolves.toBe(0);
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isFile());
    await expectMissing(fs.access(path.join(vaultRoot, ".salvage")));
  });

  it("restores malformed oversized pages after a bounded recovery scan", async () => {
    const pagePath = "sources/bounded-malformed-recovery.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(
      pageAbsPath,
      ["# Memory Bridge (test)", "## Content", "```markdown", "missing closing fence"].join("\n"),
      "utf8",
    );
    await fs.truncate(pageAbsPath, 33 * 1024 * 1024);
    const state = createImportedSourceState(pagePath, "unsafe-local");

    await expect(prune(vaultRoot, state, "unsafe-local")).resolves.toBe(0);
    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toMatchObject({ size: 33 * 1024 * 1024 });
    await expect(fs.readdir(path.dirname(pageAbsPath))).resolves.toEqual([
      "bounded-malformed-recovery.md",
    ]);
  });

  it("does not duplicate unchanged recovered Notes on repeated prunes", async () => {
    const pagePath = "sources/retry-salvage.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fs.writeFile(pageAbsPath, renderSourcePage("recovery must remain idempotent"), "utf-8");
      await expect(prune(vaultRoot, createImportedSourceState(pagePath))).resolves.toBe(1);
    }

    expect(await fs.readdir(path.join(vaultRoot, ".salvage"))).toHaveLength(1);
  });

  it("does not create salvage files for pages without human Notes", async () => {
    const pagePath = "sources/no-notes.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(pageAbsPath, "# Memory Bridge\n\n## Content\n\nNo notes here.\n", "utf-8");

    await prune(vaultRoot, createImportedSourceState(pagePath));

    const salvageDir = path.join(vaultRoot, ".salvage");
    await expectMissing(fs.access(salvageDir));
  });

  it("prunes pages even when the page file is already missing", async () => {
    const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const pagePath = "sources/missing.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);

    const removed = await prune(vaultRoot, createImportedSourceState(pagePath));

    expect(removed).toBe(1);
    await expectMissing(fs.access(pageAbsPath));
  });

  it("keeps the page when salvage write fails", async () => {
    const pagePath = "sources/keep-on-write-fail.md";
    const { vaultRoot, pageAbsPath } = await createSourceFixture(pagePath);
    await fs.writeFile(pageAbsPath, renderSourcePage("must survive", "generated"), "utf-8");

    // A file at the recovery-directory path must fail closed without deleting Notes.
    await fs.writeFile(path.join(vaultRoot, ".salvage"), "block", "utf-8");

    const removed = await prune(vaultRoot, createImportedSourceState(pagePath));

    expect(removed).toBe(0);
    const stillThere = await fs.readFile(pageAbsPath, "utf-8");
    expect(stillThere).toContain("must survive");
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
});
