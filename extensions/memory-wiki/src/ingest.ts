// Memory Wiki plugin module implements ingest behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  preserveHumanNotesBlock,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { writeGuardedVaultPage } from "./vault-page-write.js";
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

function isEmptyExistingSourcePage(error: unknown): boolean {
  return (
    error instanceof FsSafeError &&
    (error.code === "not-found" || error.code === "not-file" || error.code === "hardlink")
  );
}

async function readExistingSourcePage(
  vault: Awaited<ReturnType<typeof fsRoot>>,
  pagePath: string,
): Promise<string> {
  let readError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await vault.readText(pagePath, { maxBytes: Infinity });
    } catch (error) {
      readError = error;
    }
  }
  if (isEmptyExistingSourcePage(readError)) {
    return "";
  }
  throw readError;
}

async function ingestMemoryWikiSourceUnlocked(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
  signal?: AbortSignal;
}): Promise<IngestMemoryWikiSourceResult> {
  await initializeMemoryWikiVault(params.config, {
    ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  const sourcePath = path.resolve(params.inputPath);
  const buffer = await fs.readFile(sourcePath);
  params.signal?.throwIfAborted();
  const content = assertUtf8Text(buffer, sourcePath);
  const title = resolveSourceTitle(sourcePath, params.title);
  const slug = slugifyWikiSegment(title);
  const pageStem = slugifyWikiPageStem(title);
  const pageId = `source.${slug}`;
  const pageRelativePath = path.join("sources", `${pageStem}.md`);
  const vault = await fsRoot(params.config.vault.path);
  const pageStat = await vault.stat(pageRelativePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
  const created = !pageStat;
  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);

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

  const existing = created ? "" : await readExistingSourcePage(vault, pageRelativePath);
  params.signal?.throwIfAborted();
  await writeGuardedVaultPage({
    vault,
    pagePath: pageRelativePath,
    content: existing ? preserveHumanNotesBlock(markdown, existing) : markdown,
    pageStat,
    pageLabel: "ingested source page",
  });
  params.signal?.throwIfAborted();
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
  params.signal?.throwIfAborted();
  const compile = await compileMemoryWikiVault(
    params.config,
    params.signal ? { signal: params.signal } : undefined,
  );

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

export async function ingestMemoryWikiSource(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
  signal?: AbortSignal;
}): Promise<IngestMemoryWikiSourceResult> {
  // Ingest read-modify-writes the source page and recompiles the vault; hold
  // the vault mutation lock across the whole span so it cannot interleave
  // with the other serialized vault mutators (apply/compile/source-sync).
  return await withMemoryWikiVaultMutation(params.config.vault.path, () =>
    ingestMemoryWikiSourceUnlocked(params),
  );
}
