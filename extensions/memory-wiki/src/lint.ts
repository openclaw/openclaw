import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessPageFreshness,
  buildClaimContradictionClusters,
  collectWikiClaimHealth,
} from "./claim-health.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  decodeWikiPageUtf8,
  isUnmanagedRawSourceSummary,
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  type WikiPageSummary,
} from "./markdown.js";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";

const LINT_ISSUE_KINDS = {
  "invalid-frontmatter": ["error", "structure"],
  "missing-id": ["error", "structure"],
  "duplicate-id": ["error", "structure"],
  "missing-page-type": ["error", "structure"],
  "page-type-mismatch": ["error", "structure"],
  "missing-title": ["error", "structure"],
  "missing-source-ids": ["warning", "provenance"],
  "missing-import-provenance": ["warning", "provenance"],
  "broken-wikilink": ["warning", "links"],
  "contradiction-present": ["warning", "contradictions"],
  "claim-conflict": ["warning", "contradictions"],
  "open-question": ["warning", "open-questions"],
  "low-confidence": ["warning", "quality"],
  "claim-low-confidence": ["warning", "quality"],
  "claim-missing-evidence": ["warning", "provenance"],
  "stale-page": ["warning", "quality"],
  "stale-claim": ["warning", "quality"],
} as const;

type MemoryWikiLintIssue = ReturnType<typeof createLintIssue>;

function createLintIssue(code: keyof typeof LINT_ISSUE_KINDS, pagePath: string, message: string) {
  const [severity, category] = LINT_ISSUE_KINDS[code];
  return { severity, category, code, path: pagePath, message };
}

type LintMemoryWikiResult = {
  vaultRoot: string;
  issueCount: number;
  issues: MemoryWikiLintIssue[];
  issuesByCategory: Record<MemoryWikiLintIssue["category"], MemoryWikiLintIssue[]>;
  reportPath: string;
};

type WikiLinkTargetIndex = {
  pathTargets: Set<string>;
  aliasTargets: Set<string>;
};

function normalizeLintTarget(value: string, stripQuery = true): string {
  const withoutFragment = value.trim().replace(/\\/g, "/").split("#")[0] ?? "";
  const target = stripQuery ? (withoutFragment.split("?")[0] ?? "") : withoutFragment;
  return target
    .replace(/\.md$/i, "")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function addPathTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintTarget(raw) : "";
  if (!normalized) {
    return;
  }
  index.pathTargets.add(normalized);
  index.pathTargets.add(path.posix.basename(normalized));
}

function addSlugAliasTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintTarget(raw, false) : "";
  if (normalized) {
    index.aliasTargets.add(slugifyWikiSegment(normalized));
  }
}

function addPathSuffixTargets(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintTarget(raw) : "";
  if (!normalized) {
    return;
  }
  const parts = normalized.split("/").filter(Boolean);
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const suffix = parts.slice(partIndex).join("/");
    addPathTarget(index, suffix);
    addSlugAliasTarget(index, suffix);
  }
}

function buildWikiLinkTargetIndex(pages: WikiPageSummary[]): WikiLinkTargetIndex {
  const index: WikiLinkTargetIndex = {
    pathTargets: new Set(),
    aliasTargets: new Set(),
  };
  for (const page of pages) {
    addPathTarget(index, page.relativePath);
    const title = normalizeLowercaseStringOrEmpty(normalizeLintTarget(page.title, false));
    if (title) {
      index.aliasTargets.add(title);
    }
    addSlugAliasTarget(index, page.title);
    addPathSuffixTargets(index, page.sourcePath);
    addPathSuffixTargets(index, page.bridgeRelativePath);
    addPathSuffixTargets(index, page.unsafeLocalRelativePath);
  }
  return index;
}

function hasValidWikiLinkTarget(index: WikiLinkTargetIndex, rawTarget: string): boolean {
  const pathTarget = normalizeLintTarget(rawTarget);
  if (!pathTarget) {
    return true;
  }
  const withoutFragment = rawTarget.trim().replace(/\\/g, "/").split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const pathStyle = withoutQuery.includes("/") || /\.md$/i.test(withoutQuery);
  if (index.pathTargets.has(pathTarget) && (!withoutFragment.includes("?") || pathStyle)) {
    return true;
  }
  if (pathTarget.includes("/")) {
    return false;
  }
  const alias = normalizeLintTarget(rawTarget, false);
  return (
    index.aliasTargets.has(normalizeLowercaseStringOrEmpty(alias)) ||
    index.aliasTargets.has(slugifyWikiSegment(alias))
  );
}

function collectPageIssues(
  pages: WikiPageSummary[],
  managedImportedSourcePagePaths: Set<string>,
): MemoryWikiLintIssue[] {
  const issues: MemoryWikiLintIssue[] = [];
  const addIssue = (...args: Parameters<typeof createLintIssue>) => {
    issues.push(createLintIssue(...args));
  };
  const pagesById = new Map<string, WikiPageSummary[]>();
  const claimHealth = collectWikiClaimHealth(pages);

  for (const page of pages) {
    const requiresStructuredPageMetadata =
      !isUnmanagedRawSourceSummary(page) || managedImportedSourcePagePaths.has(page.relativePath);

    if (!page.id) {
      if (requiresStructuredPageMetadata) {
        addIssue("missing-id", page.relativePath, "Missing `id` frontmatter.");
      }
    } else {
      const current = pagesById.get(page.id) ?? [];
      current.push(page);
      pagesById.set(page.id, current);
    }

    if (!page.pageType) {
      if (requiresStructuredPageMetadata) {
        addIssue("missing-page-type", page.relativePath, "Missing `pageType` frontmatter.");
      }
    } else if (page.pageType !== page.kind) {
      addIssue(
        "page-type-mismatch",
        page.relativePath,
        `Expected pageType \`${page.kind}\`, found \`${page.pageType}\`.`,
      );
    }

    if (!page.title.trim()) {
      addIssue("missing-title", page.relativePath, "Missing page title.");
    }

    if (page.kind !== "source" && page.kind !== "report" && page.sourceIds.length === 0) {
      addIssue(
        "missing-source-ids",
        page.relativePath,
        "Non-source page is missing `sourceIds` provenance.",
      );
    }

    if (
      (page.sourceType === "memory-bridge" || page.sourceType === "memory-bridge-events") &&
      (!page.sourcePath || !page.bridgeRelativePath || !page.bridgeWorkspaceDir)
    ) {
      addIssue(
        "missing-import-provenance",
        page.relativePath,
        "Bridge-imported source page is missing `sourcePath`, `bridgeRelativePath`, or `bridgeWorkspaceDir` provenance.",
      );
    }

    if (
      (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") &&
      (!page.sourcePath || !page.unsafeLocalConfiguredPath || !page.unsafeLocalRelativePath)
    ) {
      addIssue(
        "missing-import-provenance",
        page.relativePath,
        "Unsafe-local source page is missing `sourcePath`, `unsafeLocalConfiguredPath`, or `unsafeLocalRelativePath` provenance.",
      );
    }

    if (page.contradictions.length > 0) {
      addIssue(
        "contradiction-present",
        page.relativePath,
        `Page lists ${page.contradictions.length} contradiction${page.contradictions.length === 1 ? "" : "s"} to resolve.`,
      );
    }

    if (page.questions.length > 0) {
      addIssue(
        "open-question",
        page.relativePath,
        `Page lists ${page.questions.length} open question${page.questions.length === 1 ? "" : "s"}.`,
      );
    }

    if (typeof page.confidence === "number" && page.confidence < 0.5) {
      addIssue(
        "low-confidence",
        page.relativePath,
        `Page confidence is low (${page.confidence.toFixed(2)}).`,
      );
    }

    const freshness = assessPageFreshness(page);
    if (
      requiresStructuredPageMetadata &&
      page.kind !== "report" &&
      (freshness.level === "stale" || freshness.level === "unknown")
    ) {
      addIssue(
        "stale-page",
        page.relativePath,
        `Page freshness needs review (${freshness.reason}).`,
      );
    }
  }

  for (const claim of claimHealth) {
    const label = `Claim \`${claim.claimId || claim.text}\``;
    if (claim.missingEvidence) {
      addIssue(
        "claim-missing-evidence",
        claim.pagePath,
        `${label} is missing structured evidence.`,
      );
    }
    if (typeof claim.confidence === "number" && claim.confidence < 0.5) {
      addIssue(
        "claim-low-confidence",
        claim.pagePath,
        `${label} has low confidence (${claim.confidence.toFixed(2)}).`,
      );
    }
    if (claim.freshness.level === "stale" || claim.freshness.level === "unknown") {
      addIssue(
        "stale-claim",
        claim.pagePath,
        `${label} freshness needs review (${claim.freshness.reason}).`,
      );
    }
  }

  for (const cluster of buildClaimContradictionClusters({ pages })) {
    for (const entry of cluster.entries) {
      addIssue(
        "claim-conflict",
        entry.pagePath,
        `Claim cluster \`${cluster.label}\` has competing variants across ${cluster.entries.length} pages.`,
      );
    }
  }

  for (const [id, matches] of pagesById.entries()) {
    if (matches.length > 1) {
      for (const match of matches) {
        addIssue("duplicate-id", match.relativePath, `Duplicate page id \`${id}\`.`);
      }
    }
  }

  const validTargets = buildWikiLinkTargetIndex(pages);
  for (const page of pages) {
    for (const linkTarget of page.linkTargets) {
      if (!hasValidWikiLinkTarget(validTargets, linkTarget)) {
        addIssue("broken-wikilink", page.relativePath, `Broken wikilink target \`${linkTarget}\`.`);
      }
    }
  }

  return issues.toSorted((left, right) => left.path.localeCompare(right.path));
}

function buildIssuesByCategory(
  issues: MemoryWikiLintIssue[],
): Record<MemoryWikiLintIssue["category"], MemoryWikiLintIssue[]> {
  return {
    structure: issues.filter((issue) => issue.category === "structure"),
    provenance: issues.filter((issue) => issue.category === "provenance"),
    links: issues.filter((issue) => issue.category === "links"),
    contradictions: issues.filter((issue) => issue.category === "contradictions"),
    "open-questions": issues.filter((issue) => issue.category === "open-questions"),
    quality: issues.filter((issue) => issue.category === "quality"),
  };
}

function buildLintReportBody(issues: MemoryWikiLintIssue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const byCategory = buildIssuesByCategory(issues);
  const lines = [`- Errors: ${errors.length}`, `- Warnings: ${warnings.length}`];

  const sections: Array<[string, MemoryWikiLintIssue[]]> = [
    ["Errors", errors],
    ["Warnings", warnings],
    ["Contradictions", byCategory.contradictions],
    ["Open Questions", byCategory["open-questions"]],
    ["Quality Follow-Up", [...byCategory.provenance, ...byCategory.quality]],
  ];
  for (const [heading, sectionIssues] of sections) {
    if (sectionIssues.length > 0) {
      lines.push("", `### ${heading}`);
      for (const issue of sectionIssues) {
        lines.push(`- \`${issue.path}\`: ${issue.message}`);
      }
    }
  }

  return lines.join("\n");
}

async function writeLintReport(rootDir: string, issues: MemoryWikiLintIssue[]): Promise<string> {
  const reportPath = path.join(rootDir, "reports", "lint.md");
  const directoryPath = path.dirname(reportPath);
  await fs.mkdir(directoryPath, { recursive: true });
  const dirMode = (await fs.stat(directoryPath)).mode & 0o7777;
  const originalBytes = await fs.readFile(reportPath).catch(() => null);
  const original =
    originalBytes === null
      ? renderWikiMarkdown({
          frontmatter: {
            pageType: "report",
            id: "report.lint",
            title: "Lint Report",
            status: "active",
          },
          body: "# Lint Report\n",
        })
      : decodeWikiPageUtf8(originalBytes, reportPath);
  // The lint report is itself a wiki page. Keep its metadata fail-closed before
  // replacing the managed body so malformed frontmatter is never rewritten.
  parseWikiMarkdown(original);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: "<!-- openclaw:wiki:lint:start -->",
    endMarker: "<!-- openclaw:wiki:lint:end -->",
    body: buildLintReportBody(issues),
  });
  await replaceFileAtomic({
    filePath: reportPath,
    content: withTrailingNewline(updated),
    dirMode,
    mode: 0o600,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(reportPath)}.lint-report`,
    syncTempFile: true,
    syncParentDir: true,
    throwOnCleanupError: true,
  });
  return reportPath;
}

export async function lintMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
  options: { signal?: AbortSignal } = {},
): Promise<LintMemoryWikiResult> {
  const compileResult = await compileMemoryWikiVault(
    config,
    options.signal ? { signal: options.signal } : undefined,
  );
  options.signal?.throwIfAborted();
  const sourceSyncState = await readMemoryWikiSourceSyncState(config.vault.path);
  const managedImportedSourcePagePaths = new Set(
    Object.values(sourceSyncState.entries).map((entry) => entry.pagePath.split(path.sep).join("/")),
  );
  const issues = [
    ...compileResult.frontmatterErrors.map((error) =>
      createLintIssue(
        "invalid-frontmatter",
        error.relativePath,
        `Frontmatter failed to parse: ${error.message}`,
      ),
    ),
    ...collectPageIssues(compileResult.pages, managedImportedSourcePagePaths),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  const issuesByCategory = buildIssuesByCategory(issues);
  const reportPath = await writeLintReport(config.vault.path, issues);
  options.signal?.throwIfAborted();

  await appendMemoryWikiLog(config.vault.path, {
    type: "lint",
    timestamp: new Date().toISOString(),
    details: {
      issueCount: issues.length,
      reportPath: path.relative(config.vault.path, reportPath),
    },
  });

  return {
    vaultRoot: config.vault.path,
    issueCount: issues.length,
    issues,
    issuesByCategory,
    reportPath,
  };
}
