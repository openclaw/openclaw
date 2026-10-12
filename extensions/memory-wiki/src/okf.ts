import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { forEachMarkdownCodeRange } from "./markdown-links.js";
import {
  createWikiPageFilename,
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { readWikiPageStat, writeGuardedVaultPage } from "./vault-page-write.js";
import { initializeMemoryWikiVault } from "./vault.js";

const OKF_RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const OKF_MARKDOWN_LINK_PATTERN = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
const OKF_RELATED_SECTION_PATTERN = new RegExp(
  `\\n+## Related\\n${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}\\n?`,
  "g",
);
const OKF_VOLATILE_TIMESTAMP_LINE_PATTERN = /^(?:importedAt|updatedAt): .*\n/gm;
const OKF_HASH_CHARS = 8;

type OkfConceptDocument = {
  conceptId: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  type: string;
  title: string;
};

type ImportMemoryWikiOkfWarning = {
  code: "invalid-concept" | "missing-type" | "unreadable-entry";
  path: string;
  message: string;
};

type ImportMemoryWikiOkfResult = Awaited<ReturnType<typeof importMemoryWikiOkfBundle>>;

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function createOkfBundleKey(params: {
  rootFrontmatter: Record<string, unknown>;
  bundleName: string;
  bundlePath: string;
}): string {
  const producerId =
    normalizeOptionalString(params.rootFrontmatter.id) ??
    normalizeOptionalString(params.rootFrontmatter.okf_id);
  if (producerId) {
    return slugifyWikiSegment(producerId);
  }
  const label =
    normalizeOptionalString(params.rootFrontmatter.name) ??
    normalizeOptionalString(params.rootFrontmatter.title) ??
    params.bundleName;
  const hash = createHash("sha1").update(params.bundlePath).digest("hex").slice(0, OKF_HASH_CHARS);
  return `${slugifyWikiSegment(label)}-${hash}`;
}

function createOkfPageIdentity(
  bundleKey: string,
  conceptId: string,
): { pageId: string; pagePath: string } {
  const slug = slugifyWikiSegment(conceptId.replace(/\//g, "-"));
  const hash = createHash("sha1").update(conceptId).digest("hex").slice(0, OKF_HASH_CHARS);
  const fileName = createWikiPageFilename(`okf-${bundleKey}-${slug}-${hash}`);
  const stem = fileName.replace(/\.md$/i, "");
  return {
    pageId: `concept.${stem}`,
    pagePath: `concepts/${fileName}`,
  };
}

async function collectOkfMarkdownFiles(
  rootDir: string,
  warnings: ImportMemoryWikiOkfWarning[],
): Promise<string[]> {
  const entries = await walkMemoryWikiDirectory(rootDir, "", {
    entryFilter: (entry) =>
      entry.kind === "directory" &&
      [".git", "node_modules"].includes(path.basename(entry.relativePath))
        ? "skip-subtree"
        : "include",
    onDirectoryError: "skip-and-report",
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory-error") {
      warnings.push({
        code: "unreadable-entry",
        path: toPosixPath(entry.relativePath) || ".",
        message:
          entry.error instanceof Error ? entry.error.message : "Unable to read OKF directory.",
      });
      continue;
    }
    if (entry.kind === "file" && entry.relativePath.endsWith(".md")) {
      files.push(toPosixPath(entry.relativePath));
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function parseOkfMarkdown(
  content: string,
  relativePath: string,
): {
  frontmatter: Record<string, unknown>;
  body: string;
  warning?: ImportMemoryWikiOkfWarning;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  try {
    return parseWikiMarkdown(normalizedContent);
  } catch (err) {
    return {
      frontmatter: {},
      body: normalizedContent,
      warning: {
        code: "invalid-concept",
        path: relativePath,
        message: err instanceof Error ? err.message : "Unable to parse OKF frontmatter.",
      },
    };
  }
}

async function readOkfTextFile(params: {
  bundleRoot: Awaited<ReturnType<typeof fsRoot>>;
  relativePath: string;
  warnings: ImportMemoryWikiOkfWarning[];
}): Promise<string | null> {
  return await params.bundleRoot.readText(params.relativePath).catch((err: unknown) => {
    params.warnings.push({
      code: "unreadable-entry",
      path: params.relativePath,
      message:
        err instanceof FsSafeError && err.code === "not-file"
          ? "Refusing to import OKF concept through non-regular or hardlinked file."
          : err instanceof Error
            ? err.message
            : "Unable to read OKF concept.",
    });
    return null;
  });
}

function splitMarkdownLinkDestination(target: string): {
  destination: string;
  titleSuffix: string;
} {
  const trimmed = target.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end > 0) {
      return {
        destination: trimmed.slice(1, end),
        titleSuffix: trimmed.slice(end + 1),
      };
    }
  }
  const match = trimmed.match(/^(\S+)(\s+[\s\S]+)?$/);
  return {
    destination: match?.[1] ?? trimmed,
    titleSuffix: match?.[2] ?? "",
  };
}

function resolveOkfMarkdownTarget(sourceRelativePath: string, target: string): string | null {
  const { destination } = splitMarkdownLinkDestination(target);
  const trimmed = destination.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }

  const rawTargetWithoutSuffix = trimmed.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
  const targetWithoutSuffix = safeDecodeOkfLinkPath(rawTargetWithoutSuffix);
  if (!targetWithoutSuffix || !targetWithoutSuffix.endsWith(".md")) {
    return null;
  }

  const normalized = targetWithoutSuffix.startsWith("/")
    ? path.posix.normalize(targetWithoutSuffix.slice(1))
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(sourceRelativePath), targetWithoutSuffix),
      );
  const conceptId = normalized.replace(/\.md$/i, "");
  return conceptId.startsWith("../") ? null : conceptId;
}

function safeDecodeOkfLinkPath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type OkfPage = { pageId: string; pagePath: string; title: string };
function rewriteOkfMarkdownLinks(params: {
  body: string;
  sourcePagePath: string;
  sourceRelativePath: string;
  pageByConceptId: Map<string, OkfPage>;
}) {
  const linkedPages = new Set<OkfPage>();
  if (!params.body.includes("[")) {
    return { body: params.body, linkedPages: [] };
  }
  const rewriteLinks = (markdown: string) =>
    markdown.replace(
      OKF_MARKDOWN_LINK_PATTERN,
      (match, imagePrefix: string, label: string, rawTarget: string) => {
        const conceptId = resolveOkfMarkdownTarget(params.sourceRelativePath, rawTarget);
        if (!conceptId) {
          return match;
        }
        const target = params.pageByConceptId.get(conceptId);
        if (!target) {
          return match;
        }
        linkedPages.add(target);
        const { destination, titleSuffix } = splitMarkdownLinkDestination(rawTarget);
        const relativeTarget = path.posix.relative(
          path.posix.dirname(params.sourcePagePath),
          target.pagePath,
        );
        const suffix = destination.match(/[?#].*$/s)?.[0] ?? "";
        return `${imagePrefix}[${label}](${relativeTarget}${suffix}${titleSuffix})`;
      },
    );
  const body = rewriteMarkdownOutsideCode(params.body, rewriteLinks);
  return { body, linkedPages: [...linkedPages] };
}

function rewriteMarkdownOutsideCode(
  markdown: string,
  rewriteLinks: (markdown: string) => string,
): string {
  const parts: string[] = [];
  const rewriteLines = (text: string) => text.split("\n").map(rewriteLinks).join("\n");
  let cursor = 0;
  forEachMarkdownCodeRange(markdown, (start, end) => {
    parts.push(rewriteLines(markdown.slice(cursor, start)), markdown.slice(start, end));
    cursor = end;
  });
  parts.push(rewriteLines(markdown.slice(cursor)));
  return parts.join("");
}

function normalizeOkfRenderedPageForComparison(content: string): string {
  const withoutRelated = content.replace(OKF_RELATED_SECTION_PATTERN, "\n");
  const frontmatterMatch = withoutRelated.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return withoutRelated.trimEnd();
  }
  const normalizedFrontmatter =
    frontmatterMatch[1]?.replace(OKF_VOLATILE_TIMESTAMP_LINE_PATTERN, "") ?? "";
  const frontmatterBody = normalizedFrontmatter.endsWith("\n")
    ? normalizedFrontmatter
    : `${normalizedFrontmatter}\n`;
  return `---\n${frontmatterBody}---\n${withoutRelated.slice(frontmatterMatch[0].length)}`.trimEnd();
}

async function writeOkfConceptPage(params: {
  vaultRoot: string;
  pagePath: string;
  content: string;
}): Promise<{ changed: boolean; created: boolean }> {
  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await readWikiPageStat(vault, params.pagePath);
  const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
  if (
    existing === params.content ||
    normalizeOkfRenderedPageForComparison(existing) ===
      normalizeOkfRenderedPageForComparison(params.content)
  ) {
    return { changed: false, created: !pageStat };
  }
  await writeGuardedVaultPage({
    vault,
    pagePath: params.pagePath,
    content: params.content,
    pageStat,
    pageLabel: "OKF concept page",
  });
  return { changed: true, created: !pageStat };
}

async function removeStaleOkfConceptPages(params: {
  vaultRoot: string;
  bundleKey: string;
  currentPagePaths: Set<string>;
}): Promise<string[]> {
  const vault = await fsRoot(params.vaultRoot);
  const entries = await walkMemoryWikiDirectory(params.vaultRoot, "concepts", {
    maxDepth: 0,
    entryFilter: (entry) => (entry.kind === "directory" ? "skip-subtree" : "include"),
    onDirectoryError: "skip-and-report",
  });
  const removedPagePaths: string[] = [];
  for (const entry of entries) {
    const entryName = path.basename(entry.relativePath);
    if (entry.kind !== "file" || !entryName.endsWith(".md") || entryName === "index.md") {
      continue;
    }
    const pagePath = `concepts/${entryName}`;
    if (params.currentPagePaths.has(pagePath)) {
      continue;
    }
    const raw = await vault.readText(pagePath).catch(() => "");
    const parsed = parseWikiMarkdown(raw);
    if (asNullableRecord(parsed.frontmatter.okf)?.bundleKey === params.bundleKey) {
      await vault.remove(pagePath);
      removedPagePaths.push(pagePath);
    }
  }
  return removedPagePaths;
}

export function formatOkfImportSummary(result: ImportMemoryWikiOkfResult): string {
  return `Imported ${result.importedCount} OKF concept${result.importedCount === 1 ? "" : "s"} from ${result.bundlePath} into memory wiki. Updated ${result.updatedCount}; removed ${result.removedCount}; skipped ${result.skippedCount}; refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
}

export async function importMemoryWikiOkfBundle(params: {
  config: ResolvedMemoryWikiConfig;
  bundlePath: string;
  nowMs?: number;
}) {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const bundlePath = path.resolve(params.bundlePath);
  const stat = await fs.stat(bundlePath);
  if (!stat.isDirectory()) {
    throw new Error("wiki okf import expects an unpacked OKF bundle directory.");
  }
  const bundleRoot = await fsRoot(bundlePath);

  const warnings: ImportMemoryWikiOkfWarning[] = [];
  const markdownFiles = await collectOkfMarkdownFiles(bundlePath, warnings);
  const concepts: OkfConceptDocument[] = [];
  let rootIndexContent: string | undefined;

  for (const relativePath of markdownFiles) {
    if (relativePath === "index.md") {
      rootIndexContent =
        (await readOkfTextFile({ bundleRoot, relativePath, warnings })) ?? undefined;
    }
    if (OKF_RESERVED_FILENAMES.has(path.posix.basename(relativePath))) {
      continue;
    }
    const content = await readOkfTextFile({ bundleRoot, relativePath, warnings });
    if (content === null) {
      continue;
    }
    const parsed = parseOkfMarkdown(content, relativePath);
    if (parsed.warning) {
      warnings.push(parsed.warning);
      continue;
    }
    const type = normalizeOptionalString(parsed.frontmatter.type);
    if (!type) {
      warnings.push({
        code: "missing-type",
        path: relativePath,
        message: "OKF concept is missing required non-empty type frontmatter.",
      });
      continue;
    }
    concepts.push({
      conceptId: relativePath.replace(/\.md$/i, ""),
      relativePath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      type,
      title:
        normalizeOptionalString(parsed.frontmatter.title) ??
        path.posix.basename(relativePath, ".md").replace(/[-_]+/g, " ").trim(),
    });
  }

  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);
  const bundleName = path.basename(bundlePath);
  const rootFrontmatter = parseOkfMarkdown(rootIndexContent ?? "", "index.md").frontmatter;
  const okfVersion = normalizeOptionalString(rootFrontmatter.okf_version);
  const bundleKey = createOkfBundleKey({
    rootFrontmatter,
    bundleName,
    bundlePath,
  });
  const pages = concepts.map((concept) =>
    Object.assign({}, concept, createOkfPageIdentity(bundleKey, concept.conceptId)),
  );
  const pageByConceptId = new Map(pages.map((page) => [page.conceptId, page]));

  const pagePaths: string[] = [];
  let updatedCount = 0;

  await fs.mkdir(path.join(params.config.vault.path, "concepts"), { recursive: true });
  for (const concept of pages.toSorted((left, right) =>
    left.conceptId.localeCompare(right.conceptId),
  )) {
    const rewritten = rewriteOkfMarkdownLinks({
      body: concept.body,
      sourcePagePath: concept.pagePath,
      sourceRelativePath: concept.relativePath,
      pageByConceptId,
    });
    const relationships = rewritten.linkedPages.map((target) => ({
      targetId: target.pageId,
      targetPath: target.pagePath,
      targetTitle: target.title,
      kind: "okf-link",
      evidenceKind: "okf-markdown-link",
    }));
    const description = normalizeOptionalString(concept.frontmatter.description);
    const resource = normalizeOptionalString(concept.frontmatter.resource);
    const tags = normalizeSingleOrTrimmedStringList(concept.frontmatter.tags);
    const conceptTimestamp = normalizeOptionalString(concept.frontmatter.timestamp);

    const frontmatter = {
      type: concept.type,
      pageType: "concept",
      id: concept.pageId,
      title: concept.title,
      sourceType: "okf",
      provenanceMode: "okf-import",
      sourcePath: path.join(bundlePath, concept.relativePath),
      okfConceptId: concept.conceptId,
      okfType: concept.type,
      sourceIds: [`source.okf.${bundleKey}`],
      importedAt: timestamp,
      updatedAt: conceptTimestamp ?? timestamp,
      status: "active",
      ...(description ? { description } : {}),
      ...(resource ? { resource } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(conceptTimestamp ? { okfTimestamp: conceptTimestamp } : {}),
      ...(relationships.length > 0 ? { relationships } : {}),
      okf: {
        ...(okfVersion ? { version: okfVersion } : {}),
        bundleName,
        bundleKey,
        conceptId: concept.conceptId,
        sourceRelativePath: concept.relativePath,
        frontmatter: concept.frontmatter,
      },
    };

    const writeResult = await writeOkfConceptPage({
      vaultRoot: params.config.vault.path,
      pagePath: concept.pagePath,
      content: renderWikiMarkdown({
        frontmatter,
        body: rewritten.body,
      }),
    });
    if (!writeResult.created && writeResult.changed) {
      updatedCount++;
    }
    pagePaths.push(concept.pagePath);
  }
  const currentPagePaths = new Set(pagePaths);
  const removedPagePaths =
    warnings.length === 0
      ? await removeStaleOkfConceptPages({
          vaultRoot: params.config.vault.path,
          bundleKey,
          currentPagePaths,
        })
      : [];

  await appendMemoryWikiLog(params.config.vault.path, {
    type: "okf-import",
    timestamp,
    details: {
      bundlePath,
      bundleName,
      importedCount: pagePaths.length,
      updatedCount,
      removedCount: removedPagePaths.length,
      skippedCount: warnings.length,
      pagePaths,
      removedPagePaths,
    },
  });

  const compile = await compileMemoryWikiVault(params.config);
  return {
    bundlePath,
    bundleName,
    ...(okfVersion ? { okfVersion } : {}),
    importedCount: pagePaths.length,
    updatedCount,
    removedCount: removedPagePaths.length,
    skippedCount: warnings.length,
    pagePaths,
    removedPagePaths,
    warnings,
    indexUpdatedFiles: compile.updatedFiles,
  };
}
