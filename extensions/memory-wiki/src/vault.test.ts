import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWikiPaths } from "./layout.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { initializeMemoryWikiVault, WIKI_VAULT_DIRECTORIES } from "./vault.js";

const { createVault } = createMemoryWikiTestHarness();

describe("initializeMemoryWikiVault", () => {
  it("creates the wiki layout and seed files", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-",
      config: {
        vault: {
          renderMode: "obsidian",
        },
      },
    });

    const result = await initializeMemoryWikiVault(config, {
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.created).toBe(true);
    await Promise.all(
      WIKI_VAULT_DIRECTORIES.map(async (relativeDir) => {
        await expect(fs.stat(path.join(rootDir, relativeDir))).resolves.toBeTruthy();
      }),
    );
    await expect(fs.readFile(path.join(rootDir, "AGENTS.md"), "utf8")).resolves.toContain(
      "Memory Wiki Agent Guide",
    );
    await expect(fs.readFile(path.join(rootDir, "WIKI.md"), "utf8")).resolves.toContain(
      "Render mode: `obsidian`",
    );
    await expect(
      fs.readFile(path.join(rootDir, ".openclaw-wiki", "state.json"), "utf8"),
    ).resolves.toContain('"renderMode": "obsidian"');
  });

  it("supports custom layout paths", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-custom-",
      config: {
        vault: {
          renderMode: "obsidian",
        },
        layout: {
          rootIndex: "wiki/index.md",
          overview: "wiki/overview.md",
          inbox: "raw/inbox.md",
          entitiesDir: "wiki/entities",
          conceptsDir: "wiki/concepts",
          sourcesDir: "wiki/sources",
          synthesesDir: "wiki/syntheses",
          reportsDir: "wiki/reports",
          attachmentsDir: "raw/assets",
          viewsDir: "wiki/views",
          systemDir: ".openclaw-wiki",
        },
      },
    });

    const result = await initializeMemoryWikiVault(config, {
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });
    const layout = resolveWikiPaths(config);

    expect(result.created).toBe(true);
    await expect(fs.stat(path.join(rootDir, layout.rootIndex))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(rootDir, layout.overview))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(rootDir, layout.inbox))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(rootDir, layout.entitiesDir))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(rootDir, layout.attachmentsDir))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(rootDir, layout.overview), "utf8")).resolves.toContain(
      "Render mode: `obsidian`",
    );
  });

  it("is idempotent when the vault already exists", async () => {
    const { config } = await createVault({
      prefix: "memory-wiki-",
    });

    await initializeMemoryWikiVault(config);
    const second = await initializeMemoryWikiVault(config);

    expect(second.created).toBe(false);
    expect(second.createdDirectories).toHaveLength(0);
    expect(second.createdFiles).toHaveLength(0);
  });
});
