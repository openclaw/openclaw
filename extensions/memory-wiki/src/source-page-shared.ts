import fs from "node:fs/promises";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { preserveHumanNotesBlock, renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { readExistingWikiPage, writeGuardedVaultPage } from "./vault-page-write.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];
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
  state: ImportedSourceState;
  prepareWrite?: () => Promise<unknown>;
  buildRendered: (raw: string, updatedAt: string) => string;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const shouldSkip = await shouldSkipImportedSourceWrite({
    vaultRoot: params.vaultRoot,
    syncKey: params.syncKey,
    expectedPagePath: params.pagePath,
    expectedSourcePath: params.sourcePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint: params.renderFingerprint,
    state: params.state,
  });
  if (shouldSkip) {
    return { pagePath: params.pagePath, changed: false, created: false };
  }

  // Source metadata checks stay outside vault activation. This boundary keeps
  // unchanged import polls from validating and rereading every retained page.
  await params.prepareWrite?.();
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
