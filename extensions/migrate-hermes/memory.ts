// Migrate Hermes plugin module implements memory-only import planning.
import path from "node:path";
import {
  createMigrationItem,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { exists } from "./helpers.js";
import type { HermesSource } from "./source.js";
import { resolveTargets } from "./targets.js";

export function isMemoryOnlyMigration(ctx: MigrationProviderContext): boolean {
  return Boolean(
    ctx.itemKinds && ctx.itemKinds.length > 0 && ctx.itemKinds.every((kind) => kind === "memory"),
  );
}

async function buildMemoryItem(params: {
  id: string;
  source?: string;
  sourceLabel: string;
  target: string;
  relativePath: string;
  overwrite?: boolean;
}): Promise<MigrationItem | undefined> {
  if (!params.source) {
    return undefined;
  }
  const targetExists = await exists(params.target);
  return createMigrationItem({
    id: params.id,
    kind: "memory",
    action: "copy",
    source: params.source,
    target: params.target,
    status: targetExists && !params.overwrite ? "conflict" : "planned",
    reason: targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : undefined,
    message: "Copy Hermes memory into the OpenClaw memory index.",
    details: {
      sourceType: "hermes-memory",
      sourceLabel: params.sourceLabel,
      collectionId: "hermes",
      collectionLabel: "Hermes",
      relativePath: params.relativePath,
    },
  });
}

export async function buildHermesMemoryPlan(
  ctx: MigrationProviderContext,
  source: HermesSource,
): Promise<MigrationPlan> {
  const targets = resolveTargets(ctx);
  const importRoot = path.join(targets.workspaceDir, "memory", "imports", "hermes");
  const items = (
    await Promise.all([
      buildMemoryItem({
        id: "memory:MEMORY.md",
        source: source.memoryPath,
        sourceLabel: "Hermes MEMORY.md",
        target: path.join(importRoot, "MEMORY.md"),
        relativePath: "MEMORY.md",
        overwrite: ctx.overwrite,
      }),
      buildMemoryItem({
        id: "memory:USER.md",
        source: source.userPath,
        sourceLabel: "Hermes USER.md",
        target: path.join(importRoot, "USER.md"),
        relativePath: "USER.md",
        overwrite: ctx.overwrite,
      }),
    ])
  ).filter((item): item is MigrationItem => item !== undefined);
  return {
    providerId: "hermes",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings: items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
        ]
      : [],
    nextSteps: [],
    metadata: { agentDir: targets.agentDir },
  };
}
