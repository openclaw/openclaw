import {
  createMigrationItem,
  summarizeMigrationItems,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import { resolvePlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readJsonObject, sanitizeName } from "./helpers.js";
import { buildMemoryItems } from "./memory.js";
import { buildSkillItems } from "./skills.js";
import { discoverClaudeSource, hasClaudeSource, type ClaudeSource } from "./source.js";

type MappedMcpSource = {
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  servers: Record<string, unknown>;
};

function mapMcpServers(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!name.trim() || !isRecord(value)) {
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const key of [
      "command",
      "args",
      "env",
      "cwd",
      "workingDirectory",
      "url",
      "type",
      "transport",
      "headers",
      "connectionTimeoutMs",
    ]) {
      if (value[key] !== undefined) {
        next[key] = value[key];
      }
    }
    if (Object.keys(next).length > 0) {
      mapped[name] = next;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

async function collectMcpSources(source: ClaudeSource): Promise<MappedMcpSource[]> {
  const sources: MappedMcpSource[] = [];
  const add = (
    sourceId: string,
    sourceLabel: string,
    sourcePath: string | undefined,
    raw: unknown,
  ) => {
    const servers = mapMcpServers(raw);
    if (servers && sourcePath) {
      sources.push({ sourceId, sourceLabel, sourcePath, servers });
    }
  };
  const projectMcp = await readJsonObject(source.projectMcpPath);
  add(
    "project-mcp",
    "project .mcp.json",
    source.projectMcpPath,
    projectMcp.mcpServers ?? projectMcp,
  );

  const claudeJson = await readJsonObject(source.userClaudeJsonPath);
  add("user-claude-json", "user ~/.claude.json", source.userClaudeJsonPath, claudeJson.mcpServers);

  if (source.projectDir) {
    const projectRecord = asNonArrayRecord(
      asNonArrayRecord(claudeJson.projects)[source.projectDir],
    );
    add(
      "user-claude-json-project",
      "project entry in ~/.claude.json",
      source.userClaudeJsonPath,
      projectRecord.mcpServers,
    );
  }

  const desktopConfig = await readJsonObject(source.desktopConfigPath);
  add("desktop", "Claude Desktop config", source.desktopConfigPath, desktopConfig.mcpServers);
  return sources;
}

function addArchiveItem(
  items: MigrationItem[],
  params: { id: string; source?: string; relativePath: string; message?: string },
): void {
  if (!params.source) {
    return;
  }
  items.push(
    createMigrationItem({
      id: params.id,
      kind: "archive",
      action: "archive",
      source: params.source,
      message:
        params.message ??
        "Archived in the migration report for manual review; not imported into live config.",
      details: { archiveRelativePath: params.relativePath },
    }),
  );
}

export async function buildClaudePlan(ctx: MigrationProviderContext): Promise<MigrationPlan> {
  const source = await discoverClaudeSource(ctx.source);
  if (!hasClaudeSource(source)) {
    throw new Error(
      `Claude state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolvePlannedMigrationTargets(ctx);
  const items: MigrationItem[] = [];
  const memoryOnly =
    ctx.itemKinds !== undefined &&
    ctx.itemKinds.length > 0 &&
    ctx.itemKinds.every((kind) => kind === "memory");
  items.push(
    ...(await buildMemoryItems({
      source,
      targets,
      overwrite: ctx.overwrite,
      includeInstructions: !memoryOnly,
    })),
  );
  if (!memoryOnly) {
    const mcpSources = await collectMcpSources(source);
    const counts = new Map<string, number>();
    for (const mcpSource of mcpSources) {
      for (const name of Object.keys(mcpSource.servers)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    for (const mcpSource of mcpSources) {
      for (const [name, value] of Object.entries(mcpSource.servers)) {
        const patch = { [name]: value };
        const duplicate = (counts.get(name) ?? 0) > 1;
        const conflict =
          duplicate ||
          (!ctx.overwrite &&
            hasMigrationConfigPatchConflict(ctx.config, ["mcp", "servers"], patch));
        items.push(
          createMigrationConfigPatchItem({
            id: `config:mcp-server:${sanitizeName(mcpSource.sourceId)}:${sanitizeName(name)}`,
            source: mcpSource.sourcePath,
            target: `mcp.servers.${name}`,
            path: ["mcp", "servers"],
            value: patch,
            message: `Import Claude MCP server "${name}" from ${mcpSource.sourceLabel}.`,
            conflict,
            reason: duplicate
              ? `multiple Claude MCP sources define "${name}"`
              : MIGRATION_REASON_TARGET_EXISTS,
            details: { sourceLabel: mcpSource.sourceLabel },
          }),
        );
      }
    }

    for (const settingsPath of [
      source.userSettingsPath,
      source.userLocalSettingsPath,
      source.projectSettingsPath,
      source.projectLocalSettingsPath,
    ]) {
      const settings = await readJsonObject(settingsPath);
      for (const [key, message, recommendation] of [
        [
          "hooks",
          "Claude hooks were found but are not enabled automatically.",
          "Review hook commands before recreating equivalent OpenClaw automation.",
        ],
        [
          "permissions",
          "Claude permission settings were found but are not translated automatically.",
          "Review deny and allow rules manually. Do not import broad allow rules without a policy review.",
        ],
        [
          "env",
          "Claude environment defaults were found but are not copied automatically.",
          "Move non-secret values manually and store credentials through OpenClaw credential flows.",
        ],
      ] as const) {
        if (settingsPath && settings[key] !== undefined) {
          items.push(
            createMigrationManualItem({
              id: `manual:${key}:${sanitizeName(settingsPath)}`,
              source: settingsPath,
              message,
              recommendation,
            }),
          );
        }
      }
    }

    items.push(...(await buildSkillItems({ source, targets, overwrite: ctx.overwrite })));
    for (const archivePath of source.archivePaths) {
      addArchiveItem(items, {
        id: archivePath.id,
        source: archivePath.path,
        relativePath: archivePath.relativePath,
      });
    }
    addArchiveItem(items, {
      id: "archive:CLAUDE.local.md",
      source: source.projectLocalMemoryPath,
      relativePath: "CLAUDE.local.md",
      message:
        "Claude local project memory is personal machine-local state. It is archived for manual review.",
    });
    addArchiveItem(items, {
      id: "archive:.claude/rules",
      source: source.projectRulesDir,
      relativePath: ".claude/rules",
    });
    addArchiveItem(items, {
      id: "archive:user-agents",
      source: source.userAgentsDir,
      relativePath: "agents/user",
    });
    addArchiveItem(items, {
      id: "archive:project-agents",
      source: source.projectAgentsDir,
      relativePath: "agents/project",
    });
  }

  const warnings = [
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
        ]
      : []),
    ...(items.some((item) => item.kind === "archive")
      ? [
          "Some Claude files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw.",
        ]
      : []),
    ...(items.some((item) => item.kind === "manual")
      ? ["Some Claude settings require manual review before they can be activated safely."]
      : []),
  ];
  return {
    providerId: "claude",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: memoryOnly ? [] : ["Run openclaw doctor after applying the migration."],
    metadata: { agentDir: targets.agentDir },
  };
}
