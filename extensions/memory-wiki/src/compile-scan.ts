import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { retryTransientMemoryRead } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryWikiPagePaths } from "./bounded-walk.js";
import { projectMemoryWikiImportInsight } from "./import-insights.js";
import { hashMemoryWikiVaultSources } from "./log.js";
import { scanWikiPageSummary } from "./markdown.js";
import { projectMemoryWikiOverviewItem } from "./wiki-overview.js";
import { WIKI_PAGE_GROUPS } from "./wiki-page-kinds.js";

const READ_PAGE_SUMMARIES_CONCURRENCY = 16;

async function readPageSummaryEntries(rootDir: string, filePaths: string[], signal?: AbortSignal) {
  const readResult = await runTasksWithConcurrency({
    tasks: filePaths.map((relativePath) => async () => {
      signal?.throwIfAborted();
      const absolutePath = path.join(rootDir, relativePath);
      const bytes = await retryTransientMemoryRead(
        () => fs.readFile(absolutePath),
        `read wiki page ${absolutePath}`,
      );
      signal?.throwIfAborted();
      // Large imported pages are parsed off the request path, but the compiler
      // still yields between pages so background recovery cannot starve Gateway ticks.
      await yieldToEventLoop();
      signal?.throwIfAborted();
      const contentDigest = createHash("sha256").update(bytes).digest();
      const scan = scanWikiPageSummary({ absolutePath, relativePath, raw: bytes.toString("utf8") });
      if (scan.status !== "valid") {
        return { relativePath, contentDigest, scan, importInsight: null, overviewItem: null };
      }
      const { parsed, ...summaryScan } = scan;
      return {
        relativePath,
        contentDigest,
        scan: summaryScan,
        importInsight: projectMemoryWikiImportInsight(scan.page, parsed),
        overviewItem: projectMemoryWikiOverviewItem(scan.page, parsed.body),
      };
    }),
    limit: READ_PAGE_SUMMARIES_CONCURRENCY,
    errorMode: "stop",
  });
  if (readResult.hasError) {
    throw readResult.firstError;
  }
  signal?.throwIfAborted();

  return readResult.results;
}

type PageSummaryEntry = Awaited<ReturnType<typeof readPageSummaryEntries>>[number];

function summarizePageEntries(entries: PageSummaryEntry[]) {
  return {
    entries,
    sourceGeneration: hashMemoryWikiVaultSources(
      entries.map(({ relativePath, contentDigest }) => [relativePath, contentDigest]),
    ),
    pages: entries
      .flatMap(({ scan }) => (scan.status === "valid" ? [scan.page] : []))
      .toSorted((left, right) => left.title.localeCompare(right.title)),
    frontmatterErrors: entries.flatMap(({ scan }) =>
      scan.status === "invalid-frontmatter" ? [scan.error] : [],
    ),
    importInsights: entries.flatMap(({ importInsight }) => (importInsight ? [importInsight] : [])),
    overviewItems: entries.flatMap(({ overviewItem }) => (overviewItem ? [overviewItem] : [])),
  };
}

export async function readPageSummaries(rootDir: string, signal?: AbortSignal) {
  const filePaths = (
    await Promise.all(
      WIKI_PAGE_GROUPS.map(async (group) =>
        (await listMemoryWikiPagePaths(rootDir, group.dir)).toSorted((left, right) =>
          left.localeCompare(right),
        ),
      ),
    )
  ).flat();
  signal?.throwIfAborted();
  return summarizePageEntries(await readPageSummaryEntries(rootDir, filePaths, signal));
}

export async function refreshPageSummaries(
  rootDir: string,
  previous: ReturnType<typeof summarizePageEntries>,
  updatedFiles: string[],
  signal?: AbortSignal,
) {
  const replacements = await readPageSummaryEntries(
    rootDir,
    [
      ...new Set(
        updatedFiles.map((file) => path.relative(rootDir, file).split(path.sep).join("/")),
      ),
    ],
    signal,
  );
  const entries = new Map(previous.entries.map((entry) => [entry.relativePath, entry]));
  for (const entry of replacements) {
    entries.set(entry.relativePath, entry);
  }
  // Keep discovery order, including title ties and projection/error ordering.
  // Carry each scanned byte digest with its projection so publication keeps
  // identifying the exact source bytes used, including ignored/invalid pages.
  const groupOrder = (relativePath: string) =>
    WIKI_PAGE_GROUPS.findIndex((group) => relativePath.startsWith(`${group.dir}/`));
  return summarizePageEntries(
    [...entries.values()].toSorted(
      (left, right) =>
        groupOrder(left.relativePath) - groupOrder(right.relativePath) ||
        left.relativePath.localeCompare(right.relativePath),
    ),
  );
}
