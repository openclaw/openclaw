import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  createWikiPageFilename,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
  toWikiPageSummary,
  type WikiPageSummary,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

type IngestMemoryWikiSourceResult = {
  sourcePath: string;
  pageId: string;
  pagePath: string;
  title: string;
  bytes: number;
  created: boolean;
  indexUpdatedFiles: string[];
};

type LocalFileSourcePage = WikiPageSummary & {
  sourcePath: string;
};

function pathExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function resolveSourceTitle(sourcePath: string, explicitTitle?: string): string {
  if (explicitTitle?.trim()) {
    return explicitTitle.trim();
  }
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
}

function assertUtf8Text(buffer: Buffer, sourcePath: string): string {
  const preview = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (preview.includes(0)) {
    throw new Error(`Cannot ingest binary file as markdown source: ${sourcePath}`);
  }
  return buffer.toString("utf8");
}

async function resolveCanonicalSourcePath(sourcePath: string): Promise<string> {
  return await fs.realpath(sourcePath).catch(() => path.resolve(sourcePath));
}

async function listSourceMarkdownFiles(rootDir: string): Promise<string[]> {
  const dirPath = path.join(rootDir, "sources");
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
    .map((entry) => path.join("sources", entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

async function readLocalFileSourcePages(rootDir: string): Promise<LocalFileSourcePage[]> {
  const files = await listSourceMarkdownFiles(rootDir);
  const pages = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      const page = toWikiPageSummary({ absolutePath, relativePath, raw });
      if (page?.kind !== "source" || page.sourceType !== "local-file" || !page.sourcePath) {
        return null;
      }
      return page as LocalFileSourcePage;
    }),
  );
  return pages.flatMap((page) => (page ? [page] : []));
}

async function resolveIngestSourcePageIdentity(params: {
  vaultPath: string;
  sourcePath: string;
  title: string;
}): Promise<{
  pageId: string;
  pageRelativePath: string;
}> {
  const canonicalSourcePath = await resolveCanonicalSourcePath(params.sourcePath);
  const pages = await readLocalFileSourcePages(params.vaultPath);
  const existingSourcePaths = await Promise.all(
    pages.map(async (page) => ({
      page,
      canonicalSourcePath: await resolveCanonicalSourcePath(page.sourcePath),
    })),
  );
  const existingPage = existingSourcePaths.find(
    (entry) => entry?.canonicalSourcePath === canonicalSourcePath,
  )?.page;
  if (existingPage?.id) {
    return {
      pageId: existingPage.id,
      pageRelativePath: existingPage.relativePath,
    };
  }

  const titleSlug = slugifyWikiSegment(params.title);
  // Bind identity to the resolved file path so same-source reingest stays stable.
  // Moving the file intentionally creates a new source identity.
  const sourceHash = createHash("sha1").update(canonicalSourcePath).digest("hex").slice(0, 12);
  const pageSlug = `${titleSlug}-${sourceHash}`;
  return {
    pageId: `source.${pageSlug}`,
    pageRelativePath: path.join("sources", createWikiPageFilename(pageSlug)).replace(/\\/g, "/"),
  };
}

export async function ingestMemoryWikiSource(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
}): Promise<IngestMemoryWikiSourceResult> {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const resolvedInputPath = path.resolve(params.inputPath);
  const sourcePath = await fs.realpath(resolvedInputPath).catch(() => resolvedInputPath);
  const buffer = await fs.readFile(sourcePath);
  const content = assertUtf8Text(buffer, sourcePath);
  const title = resolveSourceTitle(resolvedInputPath, params.title);
  const { pageId, pageRelativePath } = await resolveIngestSourcePageIdentity({
    vaultPath: params.config.vault.path,
    sourcePath,
    title,
  });
  const pagePath = path.join(params.config.vault.path, pageRelativePath);
  const created = !(await pathExists(pagePath));
  const timestamp = new Date(params.nowMs ?? Date.now()).toISOString();

  const markdown = renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: pageId,
      title,
      sourceType: "local-file",
      sourcePath,
      ingestedAt: timestamp,
      updatedAt: timestamp,
      status: "active",
    },
    body: [
      `# ${title}`,
      "",
      "## Source",
      `- Type: \`local-file\``,
      `- Path: \`${sourcePath}\``,
      `- Bytes: ${buffer.byteLength}`,
      `- Updated: ${timestamp}`,
      "",
      "## Content",
      renderMarkdownFence(content, "text"),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });

  await fs.writeFile(pagePath, markdown, "utf8");
  await appendMemoryWikiLog(params.config.vault.path, {
    type: "ingest",
    timestamp,
    details: {
      inputPath: sourcePath,
      pageId,
      pagePath: pageRelativePath.split(path.sep).join("/"),
      bytes: buffer.byteLength,
      created,
    },
  });
  const compile = await compileMemoryWikiVault(params.config);

  return {
    sourcePath,
    pageId,
    pagePath: pageRelativePath.split(path.sep).join("/"),
    title,
    bytes: buffer.byteLength,
    created,
    indexUpdatedFiles: compile.updatedFiles,
  };
}
