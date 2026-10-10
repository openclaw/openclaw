import fs from "node:fs/promises";
import path from "node:path";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { preserveHumanNotesBlock, renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import {
  setImportedSourceEntry,
  type MemoryWikiImportedSourceGroup,
  type MemoryWikiImportedSourceState,
} from "./source-sync-state.js";
import {
  readExistingWikiPage,
  readWikiPageStat,
  writeGuardedVaultPage,
} from "./vault-page-write.js";

export function renderImportedSourcePage(params: {
  frontmatter: Record<string, unknown> & { title: string };
  sourceHeading: string;
  sourceDetails: string[];
  content: string;
  language: string;
}): string {
  return renderWikiMarkdown({
    frontmatter: params.frontmatter,
    body: [
      `# ${params.frontmatter.title}`,
      "",
      `## ${params.sourceHeading}`,
      ...params.sourceDetails,
      "",
      "## Content",
      renderMarkdownFence(params.content, params.language),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });
}

export async function writeImportedSourcePage(params: {
  vaultRoot: string;
  syncKey: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  pagePath: string;
  group: MemoryWikiImportedSourceGroup;
  state: MemoryWikiImportedSourceState;
  prepareWrite?: () => Promise<unknown>;
  buildRendered: (raw: string, updatedAt: string) => string;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const previous = params.state.entries[params.syncKey];
  if (
    previous?.pagePath === params.pagePath &&
    previous.sourcePath === params.sourcePath &&
    previous.sourceUpdatedAtMs === params.sourceUpdatedAtMs &&
    previous.sourceSize === params.sourceSize &&
    previous.renderFingerprint === params.renderFingerprint &&
    (await fs.access(path.join(params.vaultRoot, params.pagePath)).then(
      () => true,
      () => false,
    ))
  ) {
    return { pagePath: params.pagePath, changed: false, created: false };
  }

  // Source metadata checks stay outside vault activation. This boundary keeps
  // unchanged import polls from validating and rereading every retained page.
  await params.prepareWrite?.();
  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await readWikiPageStat(vault, params.pagePath);
  const created = !pageStat;
  const updatedAt = timestampMsToIsoString(params.sourceUpdatedAtMs) ?? new Date().toISOString();
  const raw = await fs.readFile(params.sourcePath, "utf8");
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = pageStat
    ? await readExistingWikiPage(
        () => vault.readText(params.pagePath),
        (error) =>
          error instanceof FsSafeError && (error.code === "not-file" || error.code === "hardlink"),
      )
    : "";
  const nextRendered = existing ? preserveHumanNotesBlock(rendered, existing) : rendered;
  if (existing !== nextRendered) {
    await writeGuardedVaultPage({
      vault,
      pagePath: params.pagePath,
      content: nextRendered,
      pageStat,
      pageLabel: "imported source page",
    });
  }

  setImportedSourceEntry({
    syncKey: params.syncKey,
    state: params.state,
    entry: {
      group: params.group,
      pagePath: params.pagePath,
      sourcePath: params.sourcePath,
      sourceUpdatedAtMs: params.sourceUpdatedAtMs,
      sourceSize: params.sourceSize,
      renderFingerprint: params.renderFingerprint,
    },
  });
  return { pagePath: params.pagePath, changed: existing !== nextRendered, created };
}
