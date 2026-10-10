import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { preserveHumanNotesBlock, slugifyWikiPageStem, slugifyWikiSegment } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { renderImportedSourcePage } from "./source-page-shared.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { readExistingWikiPage } from "./vault-page-write.js";
import { initializeMemoryWikiVault } from "./vault.js";

export async function ingestMemoryWikiSource(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
  signal?: AbortSignal;
}) {
  // Keep the source read-modify-write and nested compile under one vault mutation lease.
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    await initializeMemoryWikiVault(params.config, {
      ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    const sourcePath = path.resolve(params.inputPath);
    const buffer = await fs.readFile(sourcePath);
    params.signal?.throwIfAborted();
    if (buffer.subarray(0, 4096).includes(0)) {
      throw new Error(`Cannot ingest binary file as markdown source: ${sourcePath}`);
    }
    const title =
      params.title?.trim() ||
      path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
    const slug = slugifyWikiSegment(title);
    const pageStem = slugifyWikiPageStem(title);
    const pageId = `source.${slug}`;
    const pageRelativePath = path.join("sources", `${pageStem}.md`);
    const pagePath = path.join(params.config.vault.path, pageRelativePath);
    const created = !(await pathExists(pagePath));
    const timestamp = resolveMemoryWikiTimestamp(params.nowMs);

    const markdown = renderImportedSourcePage({
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
      sourceHeading: "Source",
      sourceDetails: [
        `- Type: \`local-file\``,
        `- Path: \`${sourcePath}\``,
        `- Bytes: ${buffer.byteLength}`,
        `- Updated: ${timestamp}`,
      ],
      content: buffer.toString("utf8"),
      language: "text",
    });

    const existing = created
      ? ""
      : await readExistingWikiPage(
          () => fs.readFile(pagePath, "utf8"),
          (error) => {
            const code = asNullableRecord(error)?.code;
            return code === "ENOENT" || code === "EISDIR";
          },
        );
    params.signal?.throwIfAborted();
    await fs.writeFile(
      pagePath,
      existing ? preserveHumanNotesBlock(markdown, existing) : markdown,
      "utf8",
    );
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
  });
}
