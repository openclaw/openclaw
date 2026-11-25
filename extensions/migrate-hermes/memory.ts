import path from "node:path";
import {
  createMigrationItem,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import { resolvePlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import { lstatIfExists } from "openclaw/plugin-sdk/path-existence-runtime";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { HermesSource } from "./source.js";

const MIGRATION_REASON_TARGET_NOT_REGULAR = "target is not a regular file";

export function isMemoryOnlyMigration(ctx: MigrationProviderContext): boolean {
  return Boolean(
    ctx.itemKinds && ctx.itemKinds.length > 0 && ctx.itemKinds.every((kind) => kind === "memory"),
  );
}

export async function buildHermesMemoryPlan(
  ctx: MigrationProviderContext,
  source: HermesSource,
): Promise<MigrationPlan> {
  const targets = resolvePlannedMigrationTargets(ctx);
  const importRoot = path.join(targets.workspaceDir, "memory", "imports", "hermes");
  const items: MigrationItem[] = [];
  for (const [filename, sourcePath] of [
    ["MEMORY.md", source.memoryPath],
    ["USER.md", source.userPath],
  ] as const) {
    if (!sourcePath) {
      continue;
    }
    const target = path.join(importRoot, filename);
    const targetStat = await lstatIfExists(target);
    const targetNotRegular = targetStat !== undefined && !targetStat.isFile();
    const targetConflict = targetNotRegular || (targetStat !== undefined && !ctx.overwrite);
    items.push(
      createMigrationItem({
        id: `memory:${filename}`,
        kind: "memory",
        action: "copy",
        source: sourcePath,
        target,
        status: targetConflict ? "conflict" : "planned",
        reason: targetNotRegular
          ? MIGRATION_REASON_TARGET_NOT_REGULAR
          : targetConflict
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: "Copy Hermes memory into the OpenClaw memory index.",
        details: {
          sourceType: "hermes-memory",
          sourceLabel: `Hermes ${filename}`,
          collectionId: "hermes",
          collectionLabel: "Hermes",
          relativePath: filename,
        },
      }),
    );
  }
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
