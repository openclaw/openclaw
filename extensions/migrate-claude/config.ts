import {
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readJsonObject, sanitizeName } from "./helpers.js";
import type { ClaudeSource } from "./source.js";

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

export async function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  source: ClaudeSource;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  const mcpSources = await collectMcpSources(params.source);
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
        (!params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, ["mcp", "servers"], patch));
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
    params.source.userSettingsPath,
    params.source.userLocalSettingsPath,
    params.source.projectSettingsPath,
    params.source.projectLocalSettingsPath,
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

  return items;
}
