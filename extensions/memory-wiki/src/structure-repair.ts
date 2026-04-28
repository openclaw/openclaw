import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  extractTitleFromMarkdown,
  inferWikiPageKind,
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
  type WikiPageKind,
} from "./markdown.js";

const EMPTY_BODY_PATTERN = new RegExp(
  `^\\s*(?:##\\s+Related\\s*\\n?)?${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}\\s*$`,
);

export type RepairedPageOperation =
  | "backfilled-structure"
  | "updated-timestamp"
  | "removed-orphan"
  | "skipped";

export type RepairedPage = {
  relativePath: string;
  operation: RepairedPageOperation;
  fieldsAdded: string[];
  reason?: string;
};

export type RepairMemoryWikiOptions = {
  removeOrphans?: boolean;
  nowMs?: number;
};

export type RepairMemoryWikiResult = {
  vaultRoot: string;
  scanned: number;
  backfilled: number;
  orphansRemoved: number;
  pages: RepairedPage[];
};

const PAGE_DIRS: readonly { kind: WikiPageKind; dir: string }[] = [
  { kind: "source", dir: "sources" },
  { kind: "entity", dir: "entities" },
  { kind: "concept", dir: "concepts" },
  { kind: "synthesis", dir: "syntheses" },
  { kind: "report", dir: "reports" },
  { kind: "canon", dir: "canon" },
];

function deriveTitle(body: string, relativePath: string): string {
  const heading = extractTitleFromMarkdown(body);
  if (heading) {
    return heading;
  }
  const base = path.basename(relativePath, ".md");
  return base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || base;
}

function deriveId(kind: WikiPageKind, title: string, relativePath: string): string {
  const slugFromPath = slugifyWikiSegment(path.basename(relativePath, ".md").replace(/\s+/g, "-"));
  const slug = slugFromPath && slugFromPath !== "page" ? slugFromPath : slugifyWikiSegment(title);
  return `${kind}.${slug || "page"}`;
}

type FileStat = { mtimeMs: number };

async function safeStat(absolutePath: string): Promise<FileStat | null> {
  return fs.stat(absolutePath).catch(() => null);
}

function looksLikeOrphanShell(body: string): boolean {
  return EMPTY_BODY_PATTERN.test(body);
}

/**
 * Backfill any missing required frontmatter fields on a single page so that it conforms to the
 * canonical standard: `id`, `pageType`, `title`, `updatedAt`. The body is preserved exactly.
 *
 * Safe to call on a human-authored page — only adds fields that are absent.
 */
export async function ensurePageStructure(params: {
  rootDir: string;
  relativePath: string;
  nowIso: string;
}): Promise<RepairedPage> {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const kind = inferWikiPageKind(params.relativePath);
  if (!kind) {
    return {
      relativePath: params.relativePath,
      operation: "skipped",
      fieldsAdded: [],
      reason: "unknown directory",
    };
  }
  const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
  if (raw === null) {
    return {
      relativePath: params.relativePath,
      operation: "skipped",
      fieldsAdded: [],
      reason: "file missing",
    };
  }
  const parsed = parseWikiMarkdown(raw);
  const frontmatter = { ...parsed.frontmatter };
  const added: string[] = [];

  const title =
    normalizeOptionalString(frontmatter.title) ?? deriveTitle(parsed.body, params.relativePath);
  if (!normalizeOptionalString(frontmatter.title)) {
    frontmatter.title = title;
    added.push("title");
  }

  if (!normalizeOptionalString(frontmatter.pageType)) {
    frontmatter.pageType = kind;
    added.push("pageType");
  }

  if (!normalizeOptionalString(frontmatter.id)) {
    frontmatter.id = deriveId(kind, title, params.relativePath);
    added.push("id");
  }

  if (!normalizeOptionalString(frontmatter.updatedAt)) {
    const stat = await safeStat(absolutePath);
    const fallback = stat ? new Date(stat.mtimeMs).toISOString() : params.nowIso;
    frontmatter.updatedAt = fallback;
    added.push("updatedAt");
  }

  if (added.length === 0) {
    return {
      relativePath: params.relativePath,
      operation: "skipped",
      fieldsAdded: [],
    };
  }

  const rendered = renderWikiMarkdown({ frontmatter, body: parsed.body });
  if (rendered !== raw) {
    await fs.writeFile(absolutePath, rendered, "utf8");
  }
  return {
    relativePath: params.relativePath,
    operation: "backfilled-structure",
    fieldsAdded: added,
  };
}

async function listPagePaths(rootDir: string): Promise<string[]> {
  const collected: string[] = [];
  for (const { dir } of PAGE_DIRS) {
    const entries = await fs
      .readdir(path.join(rootDir, dir), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      if (entry.name === "index.md") {
        continue;
      }
      collected.push(path.join(dir, entry.name));
    }
  }
  return collected.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Walk the vault and apply deterministic structure repairs:
 *  - Inject missing `id`, `pageType`, `title`, `updatedAt` on every content page.
 *  - Optionally remove orphan source shells (files whose only content is an empty Related block).
 *
 * The function never rewrites human-authored body text and never overwrites existing
 * frontmatter values.
 */
export async function repairMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
  options: RepairMemoryWikiOptions = {},
): Promise<RepairMemoryWikiResult> {
  const rootDir = config.vault.path;
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const pagePaths = await listPagePaths(rootDir);
  const pages: RepairedPage[] = [];
  let backfilled = 0;
  let orphansRemoved = 0;

  for (const relativePath of pagePaths) {
    const absolutePath = path.join(rootDir, relativePath);
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (raw === null) {
      pages.push({
        relativePath,
        operation: "skipped",
        fieldsAdded: [],
        reason: "file disappeared",
      });
      continue;
    }
    const parsed = parseWikiMarkdown(raw);
    const hasFrontmatter = Object.keys(parsed.frontmatter).length > 0;
    const emptyBody = !parsed.body.trim() || looksLikeOrphanShell(parsed.body);
    const isOrphan = !hasFrontmatter && emptyBody && relativePath.startsWith("sources/");

    if (isOrphan) {
      if (options.removeOrphans) {
        await fs.rm(absolutePath, { force: true }).catch(() => undefined);
        pages.push({
          relativePath,
          operation: "removed-orphan",
          fieldsAdded: [],
          reason: "no frontmatter + empty body",
        });
        orphansRemoved += 1;
      } else {
        pages.push({
          relativePath,
          operation: "skipped",
          fieldsAdded: [],
          reason: "orphan shell — pass --remove-orphans to delete",
        });
      }
      continue;
    }

    const result = await ensurePageStructure({ rootDir, relativePath, nowIso });
    pages.push(result);
    if (result.operation === "backfilled-structure") {
      backfilled += 1;
    }
  }

  if (backfilled > 0 || orphansRemoved > 0) {
    await appendMemoryWikiLog(rootDir, {
      type: "repair",
      timestamp: nowIso,
      details: {
        scanned: pagePaths.length,
        backfilled,
        orphansRemoved,
      },
    });
  }

  return {
    vaultRoot: rootDir,
    scanned: pagePaths.length,
    backfilled,
    orphansRemoved,
    pages,
  };
}

/**
 * Detect orphan source shells without modifying them.
 *
 * An orphan shell is a file in `sources/` whose entire body consists of just the managed
 * `## Related` block (or a single blank line). These typically come from a deleted upstream
 * artifact followed by a stale compile pass, and they pollute link/frontmatter lints.
 */
export async function findOrphanSourceShells(config: ResolvedMemoryWikiConfig): Promise<string[]> {
  const rootDir = config.vault.path;
  const orphans: string[] = [];
  const paths = await listPagePaths(rootDir);
  for (const relativePath of paths) {
    if (!relativePath.startsWith("sources/")) {
      continue;
    }
    const absolutePath = path.join(rootDir, relativePath);
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (raw === null) {
      continue;
    }
    const parsed = parseWikiMarkdown(raw);
    if (Object.keys(parsed.frontmatter).length > 0) {
      continue;
    }
    if (!parsed.body.trim() || looksLikeOrphanShell(parsed.body)) {
      orphans.push(relativePath);
    }
  }
  return orphans;
}

export function isOrphanSourceShell(body: string): boolean {
  return !body.trim() || looksLikeOrphanShell(body);
}
