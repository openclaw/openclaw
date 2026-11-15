import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { syncMemoryWikiUnsafeLocalSources as sync } from "./unsafe-local.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
const read = (file: string) => fs.readFile(file, "utf8");
async function sources(files: Record<string, string>, name = "private") {
  const dir = await createTempDir("memory-wiki-unsafe-");
  const root = path.join(dir, name);
  await fs.mkdir(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}
async function importSources(paths: string[]) {
  const { rootDir: vaultDir, config } = await createVault({
    config: {
      vaultMode: "unsafe-local",
      unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths },
    },
  });
  return { vaultDir, config, first: await sync(config) };
}
async function addNotes(file: string, note: string) {
  await fs.writeFile(
    file,
    (await read(file)).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      () => "<!-- openclaw:human:start -->\n" + note + "\n<!-- openclaw:human:end -->",
    ),
  );
}

describe("syncMemoryWikiUnsafeLocalSources", () => {
  afterEach(() => __setFsSafeTestHooksForTest());

  it("imports explicit private paths with provenance and skips unchanged page reads", async () => {
    const dir = await sources({
      "nested/state.md": "# internal state\n",
      "nested/cache.json": '{"ok":true}\n',
      "nested/blob.bin": "\u0000\u0001",
      "events.log": "private log\n",
    });
    const { vaultDir, config, first } = await importSources([
      path.join(dir, "nested"),
      path.join(dir, "events.log"),
    ]);
    expect(first).toMatchObject({ artifactCount: 3, importedCount: 3 });
    const content = await read(path.join(vaultDir, first.pagePaths[0]!));
    expect(content).toContain("sourceType: memory-unsafe-local");
    expect(content).toContain("provenanceMode: unsafe-local");
    const retained = await Promise.all(
      first.pagePaths.map((page) => fs.realpath(path.join(vaultDir, page))),
    );
    const opened: string[] = [];
    __setFsSafeTestHooksForTest({
      beforeOpen: (file) => {
        if (retained.includes(file)) {
          opened.push(file);
        }
      },
    });
    expect(await sync(config)).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 3,
      removedCount: 0,
    });
    expect(opened).toEqual([]);
    await (await fsRoot(vaultDir)).readText(first.pagePaths[0]!);
    expect(opened).toEqual([retained[0]]);
  });

  it("preserves unavailable scopes while pruning removed files in available scopes", async () => {
    const unavailableDir = await sources({ "keep.md": "# keep me\n" });
    const availableDir = await sources({ "delete.md": "# delete me\n" });
    const { vaultDir, config, first } = await importSources([unavailableDir, availableDir]);
    const pages = await Promise.all(
      first.pagePaths.map(async (page) => ({
        page,
        content: await read(path.join(vaultDir, page)),
      })),
    );
    const unavailable = pages.find((page) => page.content.includes("# keep me"))!;
    const available = pages.find((page) => page.content.includes("# delete me"))!;
    const unavailablePath = path.join(vaultDir, unavailable.page);
    const availablePath = path.join(vaultDir, available.page);
    await addNotes(unavailablePath, "remember this");
    const humanNotes = "Durable unsafe-local annotation";
    await addNotes(availablePath, humanNotes);
    await fs.rename(unavailableDir, unavailableDir + ".offline");
    await fs.rm(path.join(availableDir, "delete.md"));
    expect(await sync(config)).toMatchObject({ artifactCount: 0, removedCount: 1 });
    await expect(read(unavailablePath)).resolves.toContain("remember this");
    await expect(fs.stat(availablePath)).rejects.toHaveProperty("code", "ENOENT");
    const salvagePath = available.page.replace(/\//g, "_") + ".notes.md";
    await expect(read(path.join(vaultDir, ".salvage", salvagePath))).resolves.toContain(humanNotes);
    await fs.rename(unavailableDir + ".offline", unavailableDir);
    expect(await sync(config)).toMatchObject({ skippedCount: 1, removedCount: 0 });
    await expect(read(unavailablePath)).resolves.toContain("remember this");
  });

  it.each([false, true])(
    "excludes generated source pages (copied outside vault: %s)",
    async (copied) => {
      const dir = await sources({
        "legitimate.md": "# legitimate\n",
        "bridge-not-generated.md": "# bridge\n",
        "unsafe-local-not-generated.md": "# unsafe\n",
      });
      const { vaultDir, config, first } = await importSources([dir]);
      const generated = first.pagePaths.find((page) => page.includes("legitimate-md"))!;
      const generatedPath = path.join(vaultDir, generated);
      if (copied) {
        const target = path.join(dir, "mirror", generated);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(generatedPath, target);
      }
      const second = await sync({
        ...config,
        unsafeLocal: { ...config.unsafeLocal, paths: copied ? [dir] : [dir, generatedPath] },
      });
      expect(second).toMatchObject({ artifactCount: 3, importedCount: 0, skippedCount: 3 });
      expect(second.pagePaths).toHaveLength(3);
    },
  );

  it("caps composed unsafe-local filenames to the filesystem component limit", async () => {
    const dir = await sources(
      { ["語".repeat(50) + "-nested/" + "録".repeat(50) + ".md"]: "# very private\n" },
      "漢".repeat(50) + "-private",
    );
    const { vaultDir, first } = await importSources([dir]);
    const page = first.pagePaths[0]!;
    expect(first.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(page))).toBeLessThanOrEqual(255);
    await expect(read(path.join(vaultDir, page))).resolves.toContain("# very private");
  });

  it("keeps an imported page out of direct-ingest title reuse", async () => {
    // A long basename caps the imported filename into the same hash-truncated
    // shape a long direct-ingest title produces. Reusing by title alone would
    // hand the imported page's id to the ingest and overwrite its provenance.
    const longName = "a".repeat(220);
    const dir = await sources({ [`${longName}.md`]: "imported body\n" });
    const { vaultDir, config, first } = await importSources([dir]);
    const importedPage = first.pagePaths[0]!;
    const importedPath = path.join(vaultDir, importedPage);
    const importedBefore = await read(importedPath);
    expect(importedBefore).toContain("sourceType: memory-unsafe-local");

    const inputDir = await createTempDir("memory-wiki-ingest-input-");
    const inputPath = path.join(inputDir, "notes.md");
    await fs.writeFile(inputPath, "direct ingest body\n");
    const ingested = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: `Unsafe Local Import: ${longName}.md`,
    });

    expect(ingested.pagePath).not.toBe(importedPage);
    expect(ingested.pageId).toMatch(/^source\.unsafe-local-import-/);
    // Compiling the vault appends its managed blocks, so compare the identity and
    // provenance the import owns, not the whole file.
    const importedAfter = await read(importedPath);
    expect(importedAfter).toContain("id: source.unsafe-local.");
    expect(importedAfter).toContain("sourceType: memory-unsafe-local");
    expect(importedAfter).toContain("imported body");
  });
});
