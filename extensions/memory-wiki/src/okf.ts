import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
  uniqueStrings,
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
import { writeGuardedVaultPage } from "./vault-page-write.js";
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
  absolutePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
};

type ImportMemoryWikiOkfWarning = {
  code: "invalid-concept" | "missing-type" | "unreadable-entry";
  path: string;
  message: string;
};

type ImportMemoryWikiOkfResult = {
  bundlePath: string;
  bundleName: string;
  okfVersion?: string;
  importedCount: number;
  updatedCount: number;
  removedCount: number;
  skippedCount: number;
  pagePaths: string[];
  removedPagePaths: string[];
  warnings: ImportMemoryWikiOkfWarning[];
  indexUpdatedFiles: string[];
};

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function trimMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

type OkfBundleMetadata = {
  key: string;
  version?: string;
};

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

function createOkfPageStem(bundleKey: string, conceptId: string): string {
  const slug = slugifyWikiSegment(conceptId.replace(/\//g, "-"));
  const hash = createHash("sha1").update(conceptId).digest("hex").slice(0, OKF_HASH_CHARS);
  return `okf-${bundleKey}-${slug}-${hash}`;
}

function createOkfPageIdentity(
  bundleKey: string,
  conceptId: string,
): { pageId: string; pagePath: string } {
  const fileName = createWikiPageFilename(createOkfPageStem(bundleKey, conceptId));
  const stem = trimMarkdownExtension(fileName);
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

function deriveOkfTitle(relativePath: string, frontmatter: Record<string, unknown>): string {
  return (
    normalizeOptionalString(frontmatter.title) ??
    path.posix.basename(relativePath, ".md").replace(/[-_]+/g, " ").trim()
  );
}

function normalizeOkfConcept(params: {
  bundlePath: string;
  relativePath: string;
  content: string;
}): { concept?: OkfConceptDocument; warning?: ImportMemoryWikiOkfWarning } {
  const parsed = parseOkfMarkdown(params.content, params.relativePath);
  if (parsed.warning) {
    return { warning: parsed.warning };
  }

  const type = normalizeOptionalString(parsed.frontmatter.type);
  if (!type) {
    return {
      warning: {
        code: "missing-type",
        path: params.relativePath,
        message: "OKF concept is missing required non-empty type frontmatter.",
      },
    };
  }

  const conceptId = trimMarkdownExtension(params.relativePath);
  const timestamp = normalizeOptionalString(parsed.frontmatter.timestamp);
  const description = normalizeOptionalString(parsed.frontmatter.description);
  const resource = normalizeOptionalString(parsed.frontmatter.resource);
  return {
    concept: {
      conceptId,
      relativePath: params.relativePath,
      absolutePath: path.join(params.bundlePath, params.relativePath),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      type,
      title: deriveOkfTitle(params.relativePath, parsed.frontmatter),
      ...(description ? { description } : {}),
      ...(resource ? { resource } : {}),
      tags: normalizeSingleOrTrimmedStringList(parsed.frontmatter.tags),
      ...(timestamp ? { timestamp } : {}),
    },
  };
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
  const conceptId = trimMarkdownExtension(normalized);
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

function getMarkdownDestinationSuffix(destination: string): string {
  const suffixIndex = destination.search(/[?#]/);
  return suffixIndex === -1 ? "" : destination.slice(suffixIndex);
}

function rewriteOkfMarkdownLinks(params: {
  body: string;
  sourcePagePath: string;
  sourceRelativePath: string;
  pageByConceptId: Map<string, { pageId: string; pagePath: string; title: string }>;
}): { body: string; linkedConceptIds: string[] } {
  const linkedConceptIds: string[] = [];
  if (!params.body.includes("[")) {
    return { body: params.body, linkedConceptIds };
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
        linkedConceptIds.push(conceptId);
        const { destination, titleSuffix } = splitMarkdownLinkDestination(rawTarget);
        const relativeTarget = path.posix.relative(
          path.posix.dirname(params.sourcePagePath),
          target.pagePath,
        );
        const suffix = getMarkdownDestinationSuffix(destination);
        return `${imagePrefix}[${label}](${relativeTarget}${suffix}${titleSuffix})`;
      },
    );
  const body = rewriteMarkdownOutsideCode(params.body, rewriteLinks);
  return { body, linkedConceptIds: uniqueStrings(linkedConceptIds) };
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
  const pageStat = await vault.stat(params.pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
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

function readRootOkfMetadata(params: {
  rootIndex: string | undefined;
  bundleName: string;
  bundlePath: string;
}): OkfBundleMetadata {
  const parsed = parseOkfMarkdown(params.rootIndex ?? "", "index.md");
  const version = normalizeOptionalString(parsed.frontmatter.okf_version);
  return {
    key: createOkfBundleKey({
      rootFrontmatter: parsed.frontmatter,
      bundleName: params.bundleName,
      bundlePath: params.bundlePath,
    }),
    ...(version ? { version } : {}),
  };
}

export function formatOkfImportSummary(result: ImportMemoryWikiOkfResult): string {
  return `Imported ${result.importedCount} OKF concept${result.importedCount === 1 ? "" : "s"} from ${result.bundlePath} into memory wiki. Updated ${result.updatedCount}; removed ${result.removedCount}; skipped ${result.skippedCount}; refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
}

export async function importMemoryWikiOkfBundle(params: {
  config: ResolvedMemoryWikiConfig;
  bundlePath: string;
  nowMs?: number;
}): Promise<ImportMemoryWikiOkfResult> {
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
    const normalized = normalizeOkfConcept({ bundlePath, relativePath, content });
    if (normalized.warning) {
      warnings.push(normalized.warning);
      continue;
    }
    if (normalized.concept) {
      concepts.push(normalized.concept);
    }
  }

  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);
  const bundleName = path.basename(bundlePath);
  const bundleMetadata = readRootOkfMetadata({
    rootIndex: rootIndexContent,
    bundleName,
    bundlePath,
  });
  const bundleKey = bundleMetadata.key;
  const pageByConceptId = new Map<string, { pageId: string; pagePath: string; title: string }>();
  for (const concept of concepts) {
    pageByConceptId.set(concept.conceptId, {
      ...createOkfPageIdentity(bundleKey, concept.conceptId),
      title: concept.title,
    });
  }

  const pagePaths: string[] = [];
  let updatedCount = 0;

  await fs.mkdir(path.join(params.config.vault.path, "concepts"), { recursive: true });
  for (const concept of concepts.toSorted((left, right) =>
    left.conceptId.localeCompare(right.conceptId),
  )) {
    const page = pageByConceptId.get(concept.conceptId);
    if (!page) {
      continue;
    }
    const rewritten = rewriteOkfMarkdownLinks({
      body: concept.body,
      sourcePagePath: page.pagePath,
      sourceRelativePath: concept.relativePath,
      pageByConceptId,
    });
    const relationships = rewritten.linkedConceptIds.flatMap((conceptId) => {
      const target = pageByConceptId.get(conceptId);
      return target
        ? [
            {
              targetId: target.pageId,
              targetPath: target.pagePath,
              targetTitle: target.title,
              kind: "okf-link",
              evidenceKind: "okf-markdown-link",
            },
          ]
        : [];
    });

    const frontmatter = {
      type: concept.type,
      pageType: "concept",
      id: page.pageId,
      title: concept.title,
      sourceType: "okf",
      provenanceMode: "okf-import",
      sourcePath: concept.absolutePath,
      okfConceptId: concept.conceptId,
      okfType: concept.type,
      sourceIds: [`source.okf.${bundleKey}`],
      importedAt: timestamp,
      updatedAt: concept.timestamp ?? timestamp,
      status: "active",
      ...(concept.description ? { description: concept.description } : {}),
      ...(concept.resource ? { resource: concept.resource } : {}),
      ...(concept.tags.length > 0 ? { tags: concept.tags } : {}),
      ...(concept.timestamp ? { okfTimestamp: concept.timestamp } : {}),
      ...(relationships.length > 0 ? { relationships } : {}),
      okf: {
        ...(bundleMetadata.version ? { version: bundleMetadata.version } : {}),
        bundleName,
        bundleKey,
        conceptId: concept.conceptId,
        sourceRelativePath: concept.relativePath,
        frontmatter: concept.frontmatter,
      },
    };

    const writeResult = await writeOkfConceptPage({
      vaultRoot: params.config.vault.path,
      pagePath: page.pagePath,
      content: renderWikiMarkdown({
        frontmatter,
        body: rewritten.body,
      }),
    });
    if (!writeResult.created && writeResult.changed) {
      updatedCount++;
    }
    pagePaths.push(page.pagePath);
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
    ...(bundleMetadata.version ? { okfVersion: bundleMetadata.version } : {}),
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
