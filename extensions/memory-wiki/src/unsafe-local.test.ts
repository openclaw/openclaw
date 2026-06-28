// Memory Wiki tests cover unsafe local plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiUnsafeLocalSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-unsafe-suite-"));
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

  async function createPrivateDir(name: string): Promise<string> {
    const privateDir = nextCaseRoot(name);
    await fs.mkdir(privateDir, { recursive: true });
    return privateDir;
  }

  it("imports explicit private paths and preserves unsafe-local provenance", async () => {
    const privateDir = await createPrivateDir("private");

    await fs.mkdir(path.join(privateDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(privateDir, "nested", "state.md"), "# internal state\n", "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "cache.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "blob.bin"), "\u0000\u0001", "utf8");
    const directPath = path.join(privateDir, "events.log");
    await fs.writeFile(directPath, "private log\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [path.join(privateDir, "nested"), directPath],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);

    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);

    const page = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-unsafe-local");
    expect(page).toContain("provenanceMode: unsafe-local");

    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);
  });

  it("prunes stale unsafe-local pages when a file inside a readable directory is deleted", async () => {
    const privateDir = await createPrivateDir("private-prune");

    const keptPath = path.join(privateDir, "kept.md");
    const removedPath = path.join(privateDir, "removed.md");
    await fs.writeFile(keptPath, "# kept\n", "utf8");
    await fs.writeFile(removedPath, "# removed\n", "utf8");

    const { config } = await createVault({
      rootDir: nextCaseRoot("prune-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    expect(first.artifactCount).toBe(2);
    expect(first.importedCount).toBe(2);

    // The configured directory stays readable, so removing one file in it is a
    // genuine deletion and the matching page must be pruned.
    await fs.rm(removedPath);
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.artifactCount).toBe(1);
    expect(second.removedCount).toBe(1);
  });

  it("keeps imported pages and human notes when a configured directory is transiently unreadable", async () => {
    const privateDir = await createPrivateDir("private-transient");
    await fs.writeFile(path.join(privateDir, "ideas.md"), "# ideas\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("transient-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const pagePath = first.pagePaths[0] ?? "";
    expect(first.importedCount).toBe(1);

    // Write a user note into the page's human-notes block, then take the source
    // directory offline the way an undocked drive / unmounted NAS presents.
    const pageAbsPath = path.join(vaultDir, pagePath);
    const original = await fs.readFile(pageAbsPath, "utf8");
    const noted = original.replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      "<!-- openclaw:human:start -->\nMY PERSONAL NOTE\n<!-- openclaw:human:end -->",
    );
    expect(noted).not.toBe(original);
    await fs.writeFile(pageAbsPath, noted, "utf8");

    const offlinePath = `${privateDir}-offline`;
    await fs.rename(privateDir, offlinePath);
    const duringOutage = await syncMemoryWikiUnsafeLocalSources(config);

    // A transient outage must not prune; the page and its human notes survive.
    expect(duringOutage.artifactCount).toBe(0);
    expect(duringOutage.removedCount).toBe(0);
    await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toContain("MY PERSONAL NOTE");

    // Re-mount and re-sync: clean reconciliation, notes still intact.
    await fs.rename(offlinePath, privateDir);
    const afterRestore = await syncMemoryWikiUnsafeLocalSources(config);
    expect(afterRestore.removedCount).toBe(0);
    await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toContain("MY PERSONAL NOTE");
  });

  it("does not prune when a nested subdirectory is transiently unreadable", async () => {
    // Root bypasses permission bits, so the unreadable-directory simulation
    // below would not actually fail; skip rather than assert a false pass.
    if (process.getuid?.() === 0) {
      return;
    }

    const privateDir = await createPrivateDir("private-nested");
    const nestedDir = path.join(privateDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, "deep.md"), "# deep\n", "utf8");
    await fs.writeFile(path.join(privateDir, "top.md"), "# top\n", "utf8");

    const { config } = await createVault({
      rootDir: nextCaseRoot("nested-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    expect(first.importedCount).toBe(2);

    // Make the nested directory unreadable (mount not ready / permissions) while
    // it still appears in the parent listing, then restore it afterward.
    await fs.chmod(nestedDir, 0o000);
    try {
      const duringOutage = await syncMemoryWikiUnsafeLocalSources(config);
      expect(duringOutage.removedCount).toBe(0);
    } finally {
      await fs.chmod(nestedDir, 0o755);
    }
  });

  it("prunes a deleted readable sibling while a nested directory is unreadable", async () => {
    // Root bypasses permission bits, so the unreadable-directory simulation
    // below would not actually fail; skip rather than assert a false pass.
    if (process.getuid?.() === 0) {
      return;
    }

    const privateDir = await createPrivateDir("private-nested-sibling");
    const nestedDir = path.join(privateDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, "deep.md"), "# deep\n", "utf8");
    const siblingPath = path.join(privateDir, "sibling.md");
    await fs.writeFile(siblingPath, "# sibling\n", "utf8");

    const { config } = await createVault({
      rootDir: nextCaseRoot("nested-sibling-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    expect(first.importedCount).toBe(2);

    // The nested directory goes offline while a readable sibling file is deleted.
    // Only the unavailable subtree is preserved; the sibling's stale page prunes.
    await fs.rm(siblingPath);
    await fs.chmod(nestedDir, 0o000);
    try {
      const second = await syncMemoryWikiUnsafeLocalSources(config);
      expect(second.removedCount).toBe(1);
    } finally {
      await fs.chmod(nestedDir, 0o755);
    }
  });

  it("keeps the imported page when an explicit configured file is transiently unavailable", async () => {
    const privateDir = await createPrivateDir("private-explicit");
    const secretPath = path.join(privateDir, "secret.md");
    await fs.writeFile(secretPath, "# private\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("explicit-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [secretPath],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const pagePath = first.pagePaths[0] ?? "";
    expect(first.importedCount).toBe(1);

    // An explicit configured file that vanishes is indistinguishable from an
    // unmounted one, so the conservative behavior keeps its page rather than
    // destroying it.
    await fs.rm(secretPath);
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.removedCount).toBe(0);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# private",
    );
  });

  it("prunes a readable source even when another configured source is unreadable", async () => {
    const readableDir = await createPrivateDir("multi-readable");
    const keptPath = path.join(readableDir, "kept.md");
    const removedPath = path.join(readableDir, "removed.md");
    await fs.writeFile(keptPath, "# kept\n", "utf8");
    await fs.writeFile(removedPath, "# removed\n", "utf8");

    const offlineDir = await createPrivateDir("multi-offline");
    await fs.writeFile(path.join(offlineDir, "notes.md"), "# notes\n", "utf8");

    const { config } = await createVault({
      rootDir: nextCaseRoot("multi-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [readableDir, offlineDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    expect(first.importedCount).toBe(3);

    // One source goes offline while the other deletes a file. The healthy source
    // must still prune its deletion; the offline source's page is preserved.
    await fs.rm(removedPath);
    await fs.rename(offlineDir, `${offlineDir}-gone`);
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.removedCount).toBe(1);
  });

  it("caps composed unsafe-local filenames to the filesystem component limit", async () => {
    const privateDir = await createPrivateDir(`${"漢".repeat(50)}-private`);
    const nestedDir = path.join(privateDir, `${"語".repeat(50)}-nested`);
    const secretPath = path.join(nestedDir, `${"録".repeat(50)}.md`);
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(secretPath, "# very private\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("long-unsafe-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const result = await syncMemoryWikiUnsafeLocalSources(config);
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# very private",
    );
  });
});
