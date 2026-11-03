import path from "node:path";
import {
  applyMigrationConfigPatchItem,
  applyMigrationManualItem,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMemoryMigrationFileItem,
  copyMigrationFileItem,
  resolvePlannedMigrationTargets,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { appendItem } from "./helpers.js";
import { buildClaudePlan } from "./plan.js";
import { applyGeneratedSkillItem } from "./skills.js";
import { discoverClaudeSource, hasClaudeSource } from "./source.js";

export function buildClaudeMigrationProvider(
  params: {
    runtime?: MigrationProviderContext["runtime"];
  } = {},
): MigrationProviderPlugin {
  return {
    id: "claude",
    label: "Claude",
    description: "Import Claude Code auto-memory, instructions, MCP servers, and skills.",
    supportedItemKinds: ["memory"],
    async detect(ctx) {
      const source = await discoverClaudeSource(ctx.source);
      const memoryOnly = ctx.itemKinds?.length === 1 && ctx.itemKinds[0] === "memory";
      const found = memoryOnly ? source.autoMemorySources.length > 0 : hasClaudeSource(source);
      return {
        found,
        source: source.root,
        label: "Claude",
        confidence: found ? source.confidence : "low",
        message: found ? "Claude state found." : "Claude state not found.",
      };
    },
    plan: buildClaudePlan,
    async apply(ctx, providedPlan?: MigrationPlan) {
      const providerRuntime = params.runtime;
      const plan = providedPlan ?? (await buildClaudePlan(ctx));
      const reportDir = ctx.reportDir ?? path.join(ctx.stateDir, "migration", "claude");
      const runtime = withCachedMigrationConfigRuntime(ctx.runtime ?? providerRuntime, ctx.config);
      const targets = resolvePlannedMigrationTargets(ctx);
      const applyCtx = { ...ctx, runtime };
      const items: MigrationItem[] = [];
      for (const item of plan.items) {
        if (item.status !== "planned") {
          items.push(item);
          continue;
        }
        if (item.kind === "config") {
          items.push(await applyMigrationConfigPatchItem(applyCtx, item));
        } else if (item.kind === "manual") {
          items.push(applyMigrationManualItem(item));
        } else if (item.action === "archive") {
          items.push(await archiveMigrationItem(item, reportDir));
        } else if (item.action === "append") {
          items.push(await appendItem(item));
        } else if (item.action === "create" && item.kind === "skill") {
          items.push(await applyGeneratedSkillItem(item, reportDir, { overwrite: ctx.overwrite }));
        } else if (item.kind === "memory") {
          items.push(
            await copyMemoryMigrationFileItem(item, reportDir, {
              workspaceDir: targets.workspaceDir,
              overwrite: ctx.overwrite,
            }),
          );
        } else {
          items.push(await copyMigrationFileItem(item, reportDir, { overwrite: ctx.overwrite }));
        }
      }
      const result: MigrationApplyResult = {
        ...plan,
        items,
        summary: summarizeMigrationItems(items),
        backupPath: ctx.backupPath,
        reportDir,
      };
      await writeMigrationReport(result, { title: "Claude Migration Report" });
      return result;
    },
  };
}
