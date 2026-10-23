import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { PlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import { lstatIfExists } from "openclaw/plugin-sdk/path-existence-runtime";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  CLAUDE_AUTO_MEMORY_MAX_FILES,
  CLAUDE_AUTO_MEMORY_MAX_SCAN_ENTRIES,
  listMarkdownFiles,
  type ClaudeSource,
} from "./source.js";

const MIGRATION_REASON_TARGET_NOT_REGULAR = "target is not a regular file";

function collectionSlug(label: string, id: string): string {
  const slug = label
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, "-")
    .replaceAll(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 72);
  return `${slug || "project"}-${id}`;
}

type MemoryDestinationBoundary = {
  source: string;
  workspace: string;
};

async function resolveMemoryDestinationBoundary(
  sourceRoot: string,
  workspaceDir: string,
): Promise<MemoryDestinationBoundary> {
  return {
    source: await fs.realpath(sourceRoot),
    workspace: await canonicalPathFromExistingAncestor(workspaceDir),
  };
}

async function assertSafeMemoryDestination(
  boundary: MemoryDestinationBoundary,
  target: string,
): Promise<void> {
  const canonicalTarget = await canonicalPathFromExistingAncestor(target);
  if (!isPathInside(boundary.workspace, canonicalTarget)) {
    throw new Error("Claude Code memory import destination must stay in the selected workspace.");
  }
  if (
    isPathInside(boundary.source, canonicalTarget) ||
    isPathInside(canonicalTarget, boundary.source)
  ) {
    throw new Error(
      "Claude Code auto-memory source and OpenClaw import destination must be separate directories.",
    );
  }
}

export async function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedMigrationTargets;
  overwrite?: boolean;
  includeInstructions?: boolean;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  if (params.includeInstructions !== false) {
    for (const [id, source, target, sourceLabel] of [
      ["workspace:CLAUDE.md", params.source.projectMemoryPath, "AGENTS.md", "project CLAUDE.md"],
      [
        "workspace:.claude/CLAUDE.md",
        params.source.projectDotClaudeMemoryPath,
        "AGENTS.md",
        "project .claude/CLAUDE.md",
      ],
      [
        "memory:user-CLAUDE.md",
        params.source.userMemoryPath,
        "USER.md",
        "user ~/.claude/CLAUDE.md",
      ],
    ] as const) {
      const targetPath = path.join(params.targets.workspaceDir, target);
      if (!source) {
        continue;
      }
      const targetNotRegular = (await lstatIfExists(targetPath))?.isFile() === false;
      items.push(
        createMigrationItem({
          id,
          kind: ["AGENTS.md", "USER.md"].includes(path.basename(targetPath))
            ? "workspace"
            : "memory",
          action: "append",
          source,
          target: targetPath,
          status: targetNotRegular ? "conflict" : "planned",
          reason: targetNotRegular ? MIGRATION_REASON_TARGET_NOT_REGULAR : undefined,
          details: { sourceLabel },
        }),
      );
    }
  }
  const autoMemoryItems: MigrationItem[] = [];
  for (const collection of params.source.autoMemorySources) {
    const destinationBoundary = await resolveMemoryDestinationBoundary(
      collection.path,
      params.targets.workspaceDir,
    );
    const targetRoot = path.join(
      params.targets.workspaceDir,
      "memory",
      "imports",
      "claude-code",
      collectionSlug(collection.label, collection.id),
    );
    await assertSafeMemoryDestination(destinationBoundary, targetRoot);
    const remaining = CLAUDE_AUTO_MEMORY_MAX_FILES - autoMemoryItems.length;
    const scan = await listMarkdownFiles(collection.path, remaining);
    if (scan.truncatedBy) {
      const limit =
        scan.truncatedBy === "files"
          ? `${CLAUDE_AUTO_MEMORY_MAX_FILES} Markdown files across all collections`
          : `${CLAUDE_AUTO_MEMORY_MAX_SCAN_ENTRIES} filesystem entries in one collection`;
      throw new Error(
        `Claude Code auto-memory exceeds the safe import limit of ${limit}. Narrow or split the source memory before importing.`,
      );
    }
    const files = scan.files;
    for (const relativePath of files) {
      const source = path.join(collection.path, relativePath);
      const target = path.join(targetRoot, relativePath);
      const targetStat = await lstatIfExists(target);
      const targetExists = targetStat !== undefined;
      const targetNotRegular = targetExists && !targetStat.isFile();
      if (!targetNotRegular) {
        await assertSafeMemoryDestination(destinationBoundary, target);
      }
      const targetConflict = targetNotRegular || (targetExists && !params.overwrite);
      autoMemoryItems.push(
        createMigrationItem({
          id: `memory:claude-auto:${collection.id}:${relativePath.replaceAll(path.sep, "/")}`,
          kind: "memory",
          action: "copy",
          source,
          target,
          status: targetConflict ? "conflict" : "planned",
          reason: targetNotRegular
            ? MIGRATION_REASON_TARGET_NOT_REGULAR
            : targetConflict
              ? MIGRATION_REASON_TARGET_EXISTS
              : undefined,
          message: "Copy Claude Code auto-memory Markdown into the OpenClaw memory index.",
          details: {
            sourceType: "claude-auto-memory",
            sourceLabel: "Claude Code auto-memory",
            collectionId: collection.id,
            collectionLabel: collection.label,
            collectionFileCount: files.length,
            relativePath: relativePath.replaceAll(path.sep, "/"),
          },
        }),
      );
    }
  }
  items.push(...autoMemoryItems);
  return items;
}
