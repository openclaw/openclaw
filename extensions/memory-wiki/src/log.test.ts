import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { importMemoryWikiLegacyLog, resolveMemoryWikiLegacyLogPath } from "./log-migration.js";
import { appendMemoryWikiLog, readMemoryWikiLogEntries } from "./log.js";

describe("memory wiki activity log", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  async function createVaultRoot(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-log-"));
  }

  it("stores activity log entries in SQLite plugin state", async () => {
    const vaultRoot = await createVaultRoot();

    await appendMemoryWikiLog(vaultRoot, {
      type: "init",
      timestamp: "2026-05-01T12:00:00.000Z",
      details: { createdFiles: ["index.md"] },
    });

    await expect(fs.stat(resolveMemoryWikiLegacyLogPath(vaultRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readMemoryWikiLogEntries(vaultRoot)).resolves.toEqual([
      {
        type: "init",
        timestamp: "2026-05-01T12:00:00.000Z",
        details: { createdFiles: ["index.md"] },
      },
    ]);
  });

  it("imports legacy JSONL activity logs only through migration", async () => {
    const vaultRoot = await createVaultRoot();
    const legacyPath = resolveMemoryWikiLegacyLogPath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        type: "compile",
        timestamp: "2026-05-01T12:30:00.000Z",
        details: { pages: 3 },
      })}\n`,
      "utf8",
    );

    await expect(importMemoryWikiLegacyLog({ vaultRoot })).resolves.toMatchObject({
      imported: 1,
      warnings: [],
      sourcePath: legacyPath,
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readMemoryWikiLogEntries(vaultRoot)).resolves.toEqual([
      {
        type: "compile",
        timestamp: "2026-05-01T12:30:00.000Z",
        details: { pages: 3 },
      },
    ]);
  });
});
