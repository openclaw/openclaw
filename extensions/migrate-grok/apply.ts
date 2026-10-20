import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  applyMigrationConfigPatchItem,
  markMigrationItemError,
  redactMigrationPlan,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  createMigrationAgent,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { applyGrokAutomationItem } from "./automations.js";
import {
  grokAgentIdentityDigest,
  grokAvatarPath,
  grokContentDigest,
  renderGrokWorkspace,
} from "./content.js";
import { applyGrokIntegrationItem } from "./integrations.js";
import { buildGrokPlan } from "./plan.js";
import { applyGrokSettingsItem } from "./settings.js";
import { createGrokAccessTokenResolver, readGrokSource } from "./source/index.js";
import type { GrokSourceInventory } from "./source/types.js";
import { resolveGrokAgentTargets } from "./targets.js";

async function readExisting(target: string): Promise<Buffer | undefined> {
  return fs.readFile(target).catch((error: unknown) => {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function applyWorkspaceItem(params: {
  item: MigrationItem;
  inventory: GrokSourceInventory;
  ctx: MigrationProviderContext;
  reportDir: string;
}): Promise<MigrationItem> {
  const { item, inventory, ctx, reportDir } = params;
  const agent = inventory.agents.value.find((entry) => entry.id === item.details?.sourceAgentId);
  const file =
    agent &&
    renderGrokWorkspace(agent).files.find((entry) => entry.path === item.details?.relativePath);
  if (!file || !item.target || grokContentDigest(file.content) !== item.sourceRevision?.digest) {
    return markMigrationItemError(
      item,
      "Grok source content changed or became unavailable. Review a new migration plan.",
    );
  }
  const existing = await readExisting(item.target);
  if (item.action === "append") {
    const body = `\n\n<!-- Imported Grok memory: ${grokContentDigest(agent!.id).slice(0, 16)} -->\n\n${String(file.content).trimEnd()}\n`;
    if (!existing?.toString("utf8").includes(body)) {
      ctx.signal?.throwIfAborted();
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await appendRegularFile({ filePath: item.target, content: body, rejectSymlinkParents: true });
    }
    return { ...item, status: "migrated", deferredCompletion: true };
  }
  if (existing && grokContentDigest(existing) === item.sourceRevision.digest) {
    return { ...item, status: "migrated", deferredCompletion: true };
  }
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-grok-content-" },
    async ({ dir }) => {
      const source = path.join(dir, path.basename(file.path));
      await fs.writeFile(source, file.content, { mode: 0o600 });
      ctx.signal?.throwIfAborted();
      const result = await copyMigrationFileItem({ ...item, source }, reportDir, {
        overwrite: ctx.overwrite,
      });
      return { ...result, source: item.source };
    },
  );
}

async function archiveSource(
  item: MigrationItem,
  inventory: GrokSourceInventory,
  reportDir: string,
): Promise<MigrationItem> {
  // Archives are review artifacts. Apply the report's redaction rules before writing them.
  const artifact = redactMigrationPlan({
    providerId: "grok",
    source: inventory.source,
    summary: summarizeMigrationItems([]),
    items: [
      {
        ...item,
        details: {
          settings: inventory.settings,
          agents: inventory.agents.value.map((agent) => ({
            id: agent.id,
            name: agent.name,
            automations: agent.automations,
            plugins: agent.plugins,
          })),
          mcpServers: inventory.mcpServers,
          issues: inventory.issues,
        },
      },
    ],
  }).items[0]!.details;
  return withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-grok-archive-" },
    async ({ dir }) => {
      const source = path.join(dir, "grok-source.json");
      await fs.writeFile(source, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
      const result = await archiveMigrationItem(
        { ...item, source, details: { archiveRelativePath: "grok-source.json" } },
        reportDir,
      );
      return { ...result, source: item.source };
    },
  );
}

export async function applyGrokPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildGrokPlan(params.ctx));
  const resolveAccessToken = createGrokAccessTokenResolver({ source: plan.source });
  const inventory = await readGrokSource({ source: plan.source, resolveAccessToken });
  const ctx = {
    ...params.ctx,
    targetAgentId:
      params.ctx.targetAgentId ??
      (typeof plan.metadata?.primaryTargetAgentId === "string"
        ? plan.metadata.primaryTargetAgentId
        : undefined),
    runtime: withCachedMigrationConfigRuntime(
      params.ctx.runtime ?? params.runtime,
      params.ctx.config,
    ),
  };
  const targets = resolveGrokAgentTargets(inventory, ctx);
  const reportDir = ctx.reportDir ?? path.join(ctx.stateDir, "migration", "grok");
  const results = new Map<MigrationItem, MigrationItem>();
  const failedAgents = new Set<string>();
  // Native creation must precede files and automations for that agent.
  const ordered = [
    ...plan.items.filter((item) => item.action === "create-agent"),
    ...plan.items.filter((item) => item.action !== "create-agent"),
  ];
  for (const item of ordered) {
    let result = item;
    const sourceAgentId =
      typeof item.details?.sourceAgentId === "string" ? item.details.sourceAgentId : undefined;
    try {
      ctx.signal?.throwIfAborted();
      if (
        item.status !== "planned" &&
        !(item.action === "create-agent" && item.deferredCompletion)
      ) {
        if (item.action === "create-agent" && sourceAgentId) {
          failedAgents.add(sourceAgentId);
        }
      } else if (sourceAgentId && failedAgents.has(sourceAgentId)) {
        result = markMigrationItemError(
          item,
          "The destination agent could not be created; its dependent content was not applied.",
        );
      } else if (item.action === "create-agent") {
        const agent = inventory.agents.value.find((entry) => entry.id === sourceAgentId);
        const target = sourceAgentId && targets.get(sourceAgentId);
        if (
          !agent ||
          !target ||
          target.isPrimary ||
          item.target !== target.agentId ||
          item.sourceRevision?.digest !== grokAgentIdentityDigest(agent)
        ) {
          result = markMigrationItemError(
            item,
            "Source agent is unavailable or its destination changed. Review a new plan.",
          );
        } else {
          const created = await createMigrationAgent(ctx, {
            id: target.agentId,
            name: agent.name,
            workspace: target.workspaceDir,
            agentDir: target.agentDir,
            identity: {
              name: agent.name,
              ...(grokAvatarPath(agent) ? { avatar: grokAvatarPath(agent) } : {}),
            },
          });
          if (created.status === "created" || created.status === "existing") {
            ctx.config = created.config;
            result = { ...item, status: "migrated", deferredCompletion: true };
          } else {
            result = { ...item, status: created.status, reason: created.reason };
          }
        }
        if (result.status !== "migrated" && sourceAgentId) {
          failedAgents.add(sourceAgentId);
        }
      } else if (item.action === "archive-grok-source") {
        result = await archiveSource(item, inventory, reportDir);
      } else if (item.action === "create-cron") {
        result = await applyGrokAutomationItem(ctx, item);
      } else if (item.details?.relativePath) {
        result = await applyWorkspaceItem({ item, inventory, ctx, reportDir });
      } else if (item.id === "config:grok:timezone") {
        result = await applyGrokSettingsItem(ctx, item);
      } else if (item.kind === "config" && item.action === "merge") {
        result = await applyMigrationConfigPatchItem(ctx, item);
      } else {
        result = await applyGrokIntegrationItem({
          ctx,
          item,
          inventory,
          agentTargets: targets,
        });
      }
    } catch (error) {
      result = markMigrationItemError(item, error instanceof Error ? error.message : String(error));
      if (item.action === "create-agent" && sourceAgentId) {
        failedAgents.add(sourceAgentId);
      }
    }
    if (result.status === "error" || result.status === "conflict") {
      delete result.deferredCompletion;
    }
    results.set(item, result);
  }
  const items = plan.items.map((item) => results.get(item) ?? item);
  const result = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Grok Bot Migration Report" });
  return result;
}
