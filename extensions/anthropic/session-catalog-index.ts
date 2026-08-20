import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { MAX_STRING_LENGTH } from "./session-catalog-desktop.js";
import type { CatalogRecord } from "./session-catalog-discovery.js";
import { probeRejectedSessionIndex } from "./session-catalog-index-probe.js";
import {
  CLAUDE_CATALOG_IO_CONCURRENCY,
  type ClaudeSessionScanContext,
  type CatalogJsonReadBudget,
  readJsonFile,
  reserveCatalogJsonFile,
  safeSessionFileForScan,
} from "./session-catalog-scan.js";

type SessionIndexEntry = {
  sessionId?: unknown;
  fullPath?: unknown;
  fileMtime?: unknown;
  firstPrompt?: unknown;
  summary?: unknown;
  messageCount?: unknown;
  created?: unknown;
  modified?: unknown;
  gitBranch?: unknown;
  projectPath?: unknown;
  isSidechain?: unknown;
};

// Claude's persisted string timestamps are date expressions, including numeric-looking years.
// Numeric fields are already millisecond values, so preserve that distinct mixed-input contract.
function parseClaudeCatalogTimestampMs(value: unknown): number | undefined {
  return parseDateFirstTimestampMs(value);
}

export async function readIndexRecords(
  context: ClaudeSessionScanContext,
  budget: CatalogJsonReadBudget,
): Promise<{
  records: Map<string, CatalogRecord>;
  sidechainIds: Set<string>;
}> {
  const records = new Map<string, CatalogRecord>();
  const sidechainIds = new Set<string>();
  if (!context.resolvedRoot) {
    return { records, sidechainIds };
  }
  const indexReads = context.projectDirectories
    .filter(({ childNames }) => childNames.includes("sessions-index.json"))
    .map(({ directory, files }) => ({
      directory,
      filePath: path.join(directory, "sessions-index.json"),
      signature: files.get("sessions-index.json"),
    }))
    .toSorted((left, right) => left.filePath.localeCompare(right.filePath));
  const admissions: Array<{
    directory: string;
    filePath: string;
    reservedBytes: number | undefined;
  }> = [];
  const rejectedIndexPaths = new Set<string>();
  for (const { directory, filePath } of indexReads) {
    let rejectionReason: "oversized" | "budget" | undefined;
    admissions.push({
      directory,
      filePath,
      reservedBytes: await reserveCatalogJsonFile(
        filePath,
        budget,
        () => {
          context.complete = false;
        },
        (reason) => {
          if (reason === "oversized" || reason === "budget") {
            rejectionReason = reason;
          }
        },
      ),
    });
    if (rejectionReason) {
      rejectedIndexPaths.add(filePath);
    }
  }
  const lateRejectedIndexPaths = new Set<string>();
  const { results: indexes } = await runTasksWithConcurrency({
    tasks: admissions.map(({ directory, filePath, reservedBytes }, index) => async () => ({
      directory,
      raw:
        reservedBytes === undefined
          ? undefined
          : await readJsonFile(filePath, {
              signature: indexReads[index]?.signature,
              budget,
              reservedBytes,
              onIoFailure: () => {
                context.complete = false;
              },
              onRejected: () => {
                lateRejectedIndexPaths.add(filePath);
              },
            }),
    })),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  const rejectedIndexDirectories = new Map(
    admissions.map(({ directory, filePath }) => [filePath, directory]),
  );
  const { results: rejectedIndexProbes } = await runTasksWithConcurrency({
    tasks: [...rejectedIndexPaths, ...lateRejectedIndexPaths].map((filePath) => async () => ({
      filePath,
      probe: await probeRejectedSessionIndex(filePath, () => {
        context.complete = false;
      }),
    })),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  for (const { probe } of rejectedIndexProbes) {
    for (const sessionId of probe.sidechainIds) {
      sidechainIds.add(sessionId);
      records.delete(sessionId);
    }
  }
  // Preserve the released scanner's index-only visibility: an oversized or
  // budget-rejected index still contributes its bounded ordinary entries, so
  // sessions that only this index discovers do not disappear on upgrade.
  for (const { filePath, probe } of rejectedIndexProbes) {
    const directory = rejectedIndexDirectories.get(filePath) ?? path.dirname(filePath);
    for (const entry of probe.entries) {
      const indexedPath = readBoundedString(entry.fullPath, MAX_STRING_LENGTH);
      const safeFile = await safeSessionFileForScan(
        context,
        indexedPath ?? path.join(directory, `${entry.sessionId}.jsonl`),
        entry.sessionId,
      );
      if (!safeFile) {
        continue;
      }
      const createdAt = parseClaudeCatalogTimestampMs(entry.created);
      const updatedAt =
        parseClaudeCatalogTimestampMs(entry.modified) ??
        parseClaudeCatalogTimestampMs(entry.fileMtime);
      const summary = readBoundedString(entry.summary, 500);
      const firstPrompt = readBoundedString(entry.firstPrompt, 500);
      records.set(entry.sessionId, {
        threadId: entry.sessionId,
        name: summary ?? firstPrompt ?? null,
        cwd: readBoundedString(entry.projectPath, MAX_STRING_LENGTH),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
        source: "claude-cli",
        modelProvider: "anthropic",
        ...(readBoundedString(entry.gitBranch, 500)
          ? { gitBranch: readBoundedString(entry.gitBranch, 500) }
          : {}),
        archived: false,
        filePath: safeFile.filePath,
      });
    }
  }
  for (const { directory, raw } of indexes) {
    if (!isRecord(raw) || !Array.isArray(raw.entries)) {
      continue;
    }
    for (const candidate of raw.entries) {
      if (!isRecord(candidate)) {
        continue;
      }
      // SAFETY: isRecord narrows this parsed JSON object; bounded readers validate its fields.
      const entry = candidate as SessionIndexEntry;
      const sessionId = readBoundedString(entry.sessionId, 256);
      if (!sessionId) {
        continue;
      }
      if (entry.isSidechain === true) {
        sidechainIds.add(sessionId);
        records.delete(sessionId);
        continue;
      }
      const indexedPath = readBoundedString(entry.fullPath, MAX_STRING_LENGTH);
      const safeFile = await safeSessionFileForScan(
        context,
        indexedPath ?? path.join(directory, `${sessionId}.jsonl`),
        sessionId,
      );
      if (!safeFile) {
        continue;
      }
      const createdAt = parseClaudeCatalogTimestampMs(entry.created);
      const updatedAt =
        parseClaudeCatalogTimestampMs(entry.modified) ??
        parseClaudeCatalogTimestampMs(entry.fileMtime);
      const summary = readBoundedString(entry.summary, 500);
      const firstPrompt = readBoundedString(entry.firstPrompt, 500);
      records.set(sessionId, {
        threadId: sessionId,
        name: summary ?? firstPrompt ?? null,
        cwd: readBoundedString(entry.projectPath, MAX_STRING_LENGTH),
        status: "stored",
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt, recencyAt: updatedAt } : {}),
        source: "claude-cli",
        modelProvider: "anthropic",
        ...(readBoundedString(entry.gitBranch, 500)
          ? { gitBranch: readBoundedString(entry.gitBranch, 500) }
          : {}),
        archived: false,
        filePath: safeFile.filePath,
      });
    }
  }
  for (const sessionId of sidechainIds) {
    records.delete(sessionId);
  }
  return { records, sidechainIds };
}
