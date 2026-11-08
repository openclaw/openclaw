import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import {
  getMemoryWikiImportRunStateStore,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();
const common = { importType: "chatgpt", createdCount: 1, skippedCount: 0 } as const;
function metadata(
  name: string,
  day: number,
  overrides: Partial<ChatGptImportRunRecord> = {},
): Omit<ChatGptImportRunRecord, "version" | "createdPaths" | "updatedPaths"> {
  return {
    ...common,
    runId: `chatgpt-${name}`,
    exportPath: `/tmp/${name}`,
    sourcePath: `/tmp/${name}/conversations.json`,
    appliedAt: `2026-04-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    conversationCount: 1,
    updatedCount: 0,
    ...overrides,
  };
}

describe("memory-wiki import runs", () => {
  it("lists import runs from plugin state", async () => {
    const vaultRoot = await createTempDir("memory-wiki-import-runs-");
    const config = resolveMemoryWikiConfig({ vault: { path: vaultRoot } });
    const old = metadata("old", 9, { rolledBackAt: "2026-04-09T11:00:00.000Z" });
    const current = metadata("new", 10, { conversationCount: 2, updatedCount: 1 });
    const rolling = metadata("rolling", 11, {
      rollbackStartedAt: "2026-04-11T10:01:00.000Z",
      rollbackTargetsFinalizedAt: "2026-04-11T10:02:00.000Z",
    });
    for (const record of [old, current, rolling]) {
      await getMemoryWikiImportRunStateStore().write(vaultRoot, {
        ...record,
        version: 1,
        createdPaths: [{ path: `sources/${record.runId.replace("chatgpt-", "")}.md` }],
        updatedPaths:
          record === current
            ? [{ path: "sources/current.md", snapshotPath: "snapshots/current.md" }]
            : [],
      });
    }

    await expect(listMemoryWikiImportRuns(config, { limit: 3 })).resolves.toEqual({
      runs: [
        {
          ...rolling,
          status: "rolling_back",
          pagePaths: ["sources/rolling.md"],
          samplePaths: ["sources/rolling.md"],
        },
        {
          ...current,
          status: "applied",
          pagePaths: ["sources/new.md", "sources/current.md"],
          samplePaths: ["sources/new.md", "sources/current.md"],
        },
        {
          ...old,
          status: "rolled_back",
          pagePaths: ["sources/old.md"],
          samplePaths: ["sources/old.md"],
        },
      ],
      totalRuns: 3,
      activeRuns: 2,
      rolledBackRuns: 1,
    });
  });
});
