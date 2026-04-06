import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiImportedSources", () => {
  it("refreshes indexes when imported sources change and skips when they do not", async () => {
    const privateDir = await createTempDir("memory-wiki-sync-private-");

    const sourcePath = path.join(privateDir, "alpha.md");
    await fs.writeFile(sourcePath, "# Alpha\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      prefix: "memory-wiki-sync-vault-",
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
      },
    });

    const first = await syncMemoryWikiImportedSources({ config });

    expect(first.indexesRefreshed).toBe(true);
    expect(first.indexRefreshReason).toBe("import-changed");
    await expect(fs.readFile(path.join(vaultDir, "index.md"), "utf8")).resolves.toContain(
      "Unsafe Local Import: alpha.md",
    );

    const second = await syncMemoryWikiImportedSources({ config });

    expect(second.indexesRefreshed).toBe(false);
    expect(second.indexRefreshReason).toBe("no-import-changes");

    await fs.rm(path.join(vaultDir, "sources", "index.md"));
    const third = await syncMemoryWikiImportedSources({ config });

    expect(third.indexesRefreshed).toBe(true);
    expect(third.indexRefreshReason).toBe("missing-indexes");
    await expect(
      fs.readFile(path.join(vaultDir, "sources", "index.md"), "utf8"),
    ).resolves.toContain("Unsafe Local Import: alpha.md");
  });

  it("respects ingest.autoCompile=false", async () => {
    const privateDir = await createTempDir("memory-wiki-sync-private-");

    const sourcePath = path.join(privateDir, "alpha.md");
    await fs.writeFile(sourcePath, "# Alpha\n", "utf8");

    const { config } = await createVault({
      prefix: "memory-wiki-sync-vault-",
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
        ingest: {
          autoCompile: false,
        },
      },
    });

    const result = await syncMemoryWikiImportedSources({ config });

    expect(result.indexesRefreshed).toBe(false);
    expect(result.indexRefreshReason).toBe("auto-compile-disabled");
  });
});
