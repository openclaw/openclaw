import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncMemoryWikiLocalImportSources } from "./local-import.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiLocalImportSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-local-import-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  async function createSourceDir(name: string): Promise<string> {
    const sourceDir = nextCaseRoot(name);
    await fs.mkdir(sourceDir, { recursive: true });
    return sourceDir;
  }

  it("imports configured local files and directories with local-import provenance", async () => {
    const sourceDir = await createSourceDir("sources");
    await fs.mkdir(path.join(sourceDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "notes", "memory.md"), "# agent memory\n", "utf8");
    await fs.writeFile(path.join(sourceDir, "notes", "facts.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(sourceDir, "notes", "blob.bin"), "\u0000\u0001", "utf8");
    const directPath = path.join(sourceDir, "daily.txt");
    await fs.writeFile(directPath, "daily note\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("vault"),
      config: {
        localImports: {
          enabled: true,
          paths: [path.join(sourceDir, "notes"), directPath],
        },
      },
    });

    const first = await syncMemoryWikiLocalImportSources(config);

    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);

    const page = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: local-import");
    expect(page).toContain("localImportConfiguredPath:");
    expect(page).toContain("## Local Import Source");

    const second = await syncMemoryWikiLocalImportSources(config);

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);
  });

  it("updates changed local import pages and prunes disappeared configured files", async () => {
    const sourceDir = await createSourceDir("update-prune");
    const sourcePath = path.join(sourceDir, "memory.md");
    await fs.writeFile(sourcePath, "# first\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("update-vault"),
      config: {
        localImports: {
          enabled: true,
          paths: [sourcePath],
        },
      },
    });

    const first = await syncMemoryWikiLocalImportSources(config);
    const pagePath = first.pagePaths[0] ?? "";
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain("# first");

    await fs.writeFile(sourcePath, "# second\n", "utf8");
    const updatedTime = new Date(Date.now() + 2_000);
    await fs.utimes(sourcePath, updatedTime, updatedTime);
    const second = await syncMemoryWikiLocalImportSources(config);

    expect(second.updatedCount).toBe(1);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain("# second");

    await fs.rm(sourcePath);
    const third = await syncMemoryWikiLocalImportSources(config);

    expect(third.artifactCount).toBe(0);
    expect(third.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, pagePath))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("returns zero artifacts when local imports are disabled or pathless", async () => {
    const { config: disabledConfig } = await createVault({
      rootDir: nextCaseRoot("disabled-vault"),
      config: {
        localImports: {
          enabled: false,
          paths: [nextCaseRoot("unused")],
        },
      },
    });
    const disabled = await syncMemoryWikiLocalImportSources(disabledConfig);
    expect(disabled.artifactCount).toBe(0);

    const { config: pathlessConfig } = await createVault({
      rootDir: nextCaseRoot("pathless-vault"),
      config: {
        localImports: {
          enabled: true,
          paths: [],
        },
      },
    });
    const pathless = await syncMemoryWikiLocalImportSources(pathlessConfig);
    expect(pathless.artifactCount).toBe(0);
  });

  it("caps composed local-import filenames to the filesystem component limit", async () => {
    const sourceDir = await createSourceDir(`${"漢".repeat(50)}-sources`);
    const nestedDir = path.join(sourceDir, `${"語".repeat(50)}-nested`);
    const sourcePath = path.join(nestedDir, `${"録".repeat(50)}.md`);
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(sourcePath, "# long path\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("long-vault"),
      config: {
        localImports: {
          enabled: true,
          paths: [sourceDir],
        },
      },
    });

    const result = await syncMemoryWikiLocalImportSources(config);
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# long path",
    );
  });
});
