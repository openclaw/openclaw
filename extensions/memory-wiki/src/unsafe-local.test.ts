import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiUnsafeLocalSources", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
  });

  async function createPrivateDir(name: string): Promise<string> {
    const privateDir = path.join(await createTempDir("memory-wiki-unsafe-"), name);
    await fs.mkdir(privateDir, { recursive: true });
    return privateDir;
  }

  async function importSources(paths: string[]) {
    const { rootDir: vaultDir, config } = await createVault({
      prefix: "memory-wiki-unsafe-vault-",
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths },
      },
    });
    return { vaultDir, config, first: await syncMemoryWikiUnsafeLocalSources(config) };
  }

  async function addNotes(pagePath: string, note: string) {
    const page = await fs.readFile(pagePath, "utf8");
    await fs.writeFile(
      pagePath,
      page.replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        () => `<!-- openclaw:human:start -->\n${note}\n<!-- openclaw:human:end -->`,
      ),
      "utf8",
    );
    return page;
  }

  it("imports explicit private paths and preserves unsafe-local provenance", async () => {
    const privateDir = await createPrivateDir("private");

    await fs.mkdir(path.join(privateDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(privateDir, "nested", "state.md"), "# internal state\n", "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "cache.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "blob.bin"), "\u0000\u0001", "utf8");
    const directPath = path.join(privateDir, "events.log");
    await fs.writeFile(directPath, "private log\n", "utf8");

    const { vaultDir, config, first } = await importSources([
      path.join(privateDir, "nested"),
      directPath,
    ]);

    expect(first).toMatchObject({
      artifactCount: 3,
      importedCount: 3,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
    });

    const page = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-unsafe-local");
    expect(page).toContain("provenanceMode: unsafe-local");

    const readFile = vi.spyOn(fs, "readFile");
    const retainedPages = new Set(
      await Promise.all(
        first.pagePaths.map((pagePath) => fs.realpath(path.join(vaultDir, pagePath))),
      ),
    );
    const openedPages: string[] = [];
    __setFsSafeTestHooksForTest({
      beforeOpen: (filePath) => {
        if (retainedPages.has(filePath)) {
          openedPages.push(filePath);
        }
      },
    });
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 3,
      removedCount: 0,
    });
    expect(
      readFile.mock.calls.some(
        ([filePath]) => typeof filePath === "string" && filePath.startsWith(vaultDir),
      ),
    ).toBe(false);
    expect(openedPages).toEqual([]);

    const canaryPage = first.pagePaths[0]!;
    await (await fsRoot(vaultDir)).readText(canaryPage);
    expect(openedPages).toEqual([await fs.realpath(path.join(vaultDir, canaryPage))]);
  });

  it("preserves unavailable paths while salvaging notes from removed files", async () => {
    const unavailableDir = await createPrivateDir("temporarily-unavailable");
    const availableDir = await createPrivateDir("still-available");
    const unavailableSource = path.join(unavailableDir, "keep.md");
    const availableSource = path.join(availableDir, "delete.md");
    await fs.writeFile(unavailableSource, "# keep me\n", "utf8");
    await fs.writeFile(availableSource, "# delete me\n", "utf8");

    const { vaultDir, config, first } = await importSources([unavailableDir, availableDir]);
    const pageContents = await Promise.all(
      first.pagePaths.map(async (pagePath) => ({
        pagePath,
        content: await fs.readFile(path.join(vaultDir, pagePath), "utf8"),
      })),
    );
    const unavailablePage = pageContents.find((page) => page.content.includes("# keep me"));
    const availablePage = pageContents.find((page) => page.content.includes("# delete me"));
    expect(unavailablePage).toBeDefined();
    expect(availablePage).toBeDefined();
    const unavailablePagePath = path.join(vaultDir, unavailablePage!.pagePath);
    const availablePagePath = path.join(vaultDir, availablePage!.pagePath);
    await addNotes(unavailablePagePath, "remember this");
    const humanNotes = "Durable unsafe-local annotation";
    expect(await addNotes(availablePagePath, humanNotes)).toContain("# delete me");

    const offlinePath = `${unavailableDir}.offline`;
    await fs.rename(unavailableDir, offlinePath);
    await fs.rm(availableSource);
    const duringOutage = await syncMemoryWikiUnsafeLocalSources(config);

    expect(duringOutage).toMatchObject({ artifactCount: 0, removedCount: 1 });
    await expect(fs.readFile(unavailablePagePath, "utf8")).resolves.toContain("remember this");
    await expect(fs.stat(availablePagePath)).rejects.toHaveProperty("code", "ENOENT");
    const salvagePath = availablePage!.pagePath.replace(/\//g, "_") + ".notes.md";
    await expect(
      fs.readFile(path.join(vaultDir, ".salvage", salvagePath), "utf8"),
    ).resolves.toContain(humanNotes);

    await fs.rename(offlinePath, unavailableDir);
    const afterRecovery = await syncMemoryWikiUnsafeLocalSources(config);

    expect(afterRecovery).toMatchObject({ skippedCount: 1, removedCount: 0 });
    await expect(fs.readFile(unavailablePagePath, "utf8")).resolves.toContain("remember this");
  });

  it("skips generated source pages copied into a configured path", async () => {
    const privateDir = await createPrivateDir("copied-vault");
    const sourcePaths = [
      path.join(privateDir, "legitimate.md"),
      path.join(privateDir, "bridge-not-generated.md"),
      path.join(privateDir, "unsafe-local-not-generated.md"),
    ];
    await Promise.all(
      sourcePaths.map((sourcePath) => fs.writeFile(sourcePath, `# ${path.basename(sourcePath)}\n`)),
    );
    const { vaultDir, config, first } = await importSources([privateDir]);
    const generatedPage = first.pagePaths.find((pagePath) => pagePath.includes("legitimate-md"));
    expect(generatedPage).toBeDefined();
    const copiedPage = path.join(privateDir, "mirror", generatedPage!);
    await fs.mkdir(path.dirname(copiedPage), { recursive: true });
    await fs.copyFile(path.join(vaultDir, generatedPage!), copiedPage);

    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second).toMatchObject({
      artifactCount: sourcePaths.length,
      importedCount: 0,
      skippedCount: sourcePaths.length,
    });
    expect(second.pagePaths).toHaveLength(sourcePaths.length);
  });

  it("skips a configured source whose canonical path is inside the active vault", async () => {
    const privateDir = await createPrivateDir("canonical-vault");
    const sourcePath = path.join(privateDir, "legitimate.md");
    await fs.writeFile(sourcePath, "# legitimate\n", "utf8");
    const { vaultDir, config, first } = await importSources([sourcePath]);
    const generatedPage = path.join(vaultDir, first.pagePaths[0] ?? "");
    const second = await syncMemoryWikiUnsafeLocalSources({
      ...config,
      unsafeLocal: {
        ...config.unsafeLocal,
        paths: [sourcePath, generatedPage],
      },
    });

    expect(second).toMatchObject({ artifactCount: 1, importedCount: 0, skippedCount: 1 });
    expect(second.pagePaths).toHaveLength(1);
  });

  it("caps composed unsafe-local filenames to the filesystem component limit", async () => {
    const privateDir = await createPrivateDir(`${"漢".repeat(50)}-private`);
    const nestedDir = path.join(privateDir, `${"語".repeat(50)}-nested`);
    const secretPath = path.join(nestedDir, `${"録".repeat(50)}.md`);
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(secretPath, "# very private\n", "utf8");

    const { vaultDir, first: result } = await importSources([privateDir]);
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# very private",
    );
  });
});
