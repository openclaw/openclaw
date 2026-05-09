import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  importMemoryWikiLegacySourceSyncState,
  resolveMemoryWikiLegacySourceSyncStatePath,
} from "./source-sync-state-migration.js";
import {
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

describe("memory wiki source sync state", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  async function createVaultRoot(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-sync-"));
  }

  it("persists source sync entries in SQLite plugin state", async () => {
    const vaultRoot = await createVaultRoot();

    await writeMemoryWikiSourceSyncState(vaultRoot, {
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/workspace/MEMORY.md",
          sourceUpdatedAtMs: 123,
          sourceSize: 456,
          renderFingerprint: "fingerprint",
        },
      },
    });

    await expect(
      fs.stat(resolveMemoryWikiLegacySourceSyncStatePath(vaultRoot)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/workspace/MEMORY.md",
          sourceUpdatedAtMs: 123,
          sourceSize: 456,
          renderFingerprint: "fingerprint",
        },
      },
    });
  });

  it("imports the legacy JSON ledger only through the migration helper", async () => {
    const vaultRoot = await createVaultRoot();
    const legacyPath = resolveMemoryWikiLegacySourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        entries: {
          beta: {
            group: "unsafe-local",
            pagePath: "sources/beta.md",
            sourcePath: "/tmp/private/beta.md",
            sourceUpdatedAtMs: 321,
            sourceSize: 654,
            renderFingerprint: "legacy-fingerprint",
          },
        },
      }),
      "utf8",
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {},
    });

    await expect(importMemoryWikiLegacySourceSyncState({ vaultRoot })).resolves.toMatchObject({
      imported: 1,
      warnings: [],
      sourcePath: legacyPath,
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {
        beta: {
          group: "unsafe-local",
          pagePath: "sources/beta.md",
          sourcePath: "/tmp/private/beta.md",
          sourceUpdatedAtMs: 321,
          sourceSize: 654,
          renderFingerprint: "legacy-fingerprint",
        },
      },
    });
  });
});
