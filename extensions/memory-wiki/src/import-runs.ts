import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  getMemoryWikiImportRunStateStore,
  type ChatGptImportRunRecord,
} from "./import-runs-state.js";

type MemoryWikiImportRunSummary = Omit<
  ChatGptImportRunRecord,
  "version" | "createdPaths" | "updatedPaths"
> & {
  status: "applied" | "rolling_back" | "rolled_back";
  pagePaths: string[];
  samplePaths: string[];
};

function toImportRunSummary(record: ChatGptImportRunRecord): MemoryWikiImportRunSummary {
  const { version: _version, createdPaths, updatedPaths, ...metadata } = record;
  const pagePaths = uniqueStrings([...createdPaths, ...updatedPaths].map((entry) => entry.path));
  const rollingBack = Boolean(record.rollbackStartedAt || record.rollbackTargetsFinalizedAt);

  return {
    ...metadata,
    status: record.rolledBackAt ? "rolled_back" : rollingBack ? "rolling_back" : "applied",
    pagePaths,
    samplePaths: pagePaths.slice(0, 5),
  };
}

export async function listMemoryWikiImportRuns(
  config: ResolvedMemoryWikiConfig,
  options?: { limit?: number },
) {
  const limit = Math.max(1, Math.floor(options?.limit ?? 10));
  const runs = (await getMemoryWikiImportRunStateStore().list(config.vault.path))
    .map(toImportRunSummary)
    .toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt));

  return {
    runs: runs.slice(0, limit),
    totalRuns: runs.length,
    activeRuns: runs.filter((entry) => entry.status !== "rolled_back").length,
    rolledBackRuns: runs.filter((entry) => entry.status === "rolled_back").length,
  };
}
