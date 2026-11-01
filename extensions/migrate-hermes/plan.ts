import path from "node:path";
import {
  createMigrationConfigPatchItem,
  createMigrationItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  markMigrationItemConflict,
  mergeMigrationConfigValue,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import { resolvePlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  asNonArrayRecord,
  filterStringRecord,
  isRecord,
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseYaml } from "yaml";
import { buildAuthItems } from "./auth.js";
import { planHermesMcpServer } from "./config-mcp.js";
import { providerConfig } from "./config-provider-contract.js";
import {
  addSelectedModelToProvider,
  collectHermesProviders,
  providerManualItems,
} from "./config-providers.js";
import { exists, parseEnv, parseHermesConfig, readUtf8Text, sanitizeName } from "./helpers.js";
import {
  createHermesModelItem,
  findHermesModelProviderDependency,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
} from "./items.js";
import { buildHermesMemoryPlan, isMemoryOnlyMigration } from "./memory.js";
import {
  resolveCurrentModelRef,
  resolveHermesModelRef,
  usesRetiredHermesQwenProvider,
} from "./model.js";
import { buildSecretItems } from "./secrets.js";
import { buildSkillItems } from "./skills.js";
import { discoverHermesSource, hasHermesSource } from "./source.js";

function mapSkillEntries(config: Record<string, unknown>): Record<string, unknown> {
  const skills = asNonArrayRecord(config.skills);
  const entries = new Map<string, { config?: Record<string, unknown>; enabled?: false }>();
  for (const [skillKey, value] of Object.entries(asNonArrayRecord(skills.config))) {
    if (isRecord(value)) {
      entries.set(skillKey, { config: value });
    }
  }
  let disabled = skills.disabled;
  // Hermes config commands also persist JSON/Python array strings. YAML accepts
  // both list forms without evaluating source code; malformed strings stay names.
  if (typeof disabled === "string" && disabled.trimStart().startsWith("[")) {
    try {
      disabled = parseYaml(disabled);
    } catch {
      // Hermes treats a malformed list string as a single skill name.
    }
  }
  for (const skillKey of normalizeSingleOrTrimmedStringList(disabled)) {
    // Hermes always keeps its operating manual active, even in skills.disabled.
    if (skillKey !== "hermes-agent") {
      entries.set(skillKey, { ...entries.get(skillKey), enabled: false });
    }
  }
  // Apply the shared untrusted-key policy before skill names become path segments.
  return asNonArrayRecord(mergeMigrationConfigValue({}, Object.fromEntries(entries)));
}

export async function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan> {
  const source = await discoverHermesSource(ctx.source);
  if (isMemoryOnlyMigration(ctx)) {
    return await buildHermesMemoryPlan(ctx, source);
  }
  if (!hasHermesSource(source)) {
    throw new Error(
      `Hermes state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolvePlannedMigrationTargets(ctx);
  let config: Record<string, unknown>;
  try {
    config = parseHermesConfig(await readUtf8Text(source.configPath));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Hermes config at ${source.configPath}: ${reason}`, {
      cause: err,
    });
  }
  const env = parseEnv(await readUtf8Text(source.envPath));
  const modelRef = resolveHermesModelRef(config, env);
  const runtimeEnv = filterStringRecord(process.env) ?? {};
  const items: MigrationItem[] = [];

  let modelItemIndex: number | undefined;
  if (modelRef) {
    const currentModel = resolveCurrentModelRef(ctx);
    modelItemIndex = items.length;
    items.push(
      createHermesModelItem({
        model: modelRef,
        currentModel,
        targetAgentId: ctx.targetAgentId,
        overwrite: ctx.overwrite,
      }),
    );
  }
  const hasMemoryFiles = Boolean(source.memoryPath || source.userPath);
  const configItems: MigrationItem[] = [];
  const addConfigPatch = (patch: Parameters<typeof createMigrationConfigPatchItem>[0]) => {
    configItems.push(
      createMigrationConfigPatchItem({
        ...patch,
        conflict:
          !ctx.overwrite && hasMigrationConfigPatchConflict(ctx.config, patch.path, patch.value),
      }),
    );
  };
  const memory = asNonArrayRecord(config.memory);
  const memoryProvider = normalizeOptionalString(memory.provider);

  if (hasMemoryFiles || memoryProvider) {
    addConfigPatch({
      id: "config:memory-plugin-slot",
      target: "plugins.slots",
      path: ["plugins", "slots"],
      value: { memory: "memory-core" },
      message: "Select the default OpenClaw memory plugin for imported file memory.",
    });
  }

  if (memoryProvider === "honcho") {
    const value = {
      honcho: {
        enabled: true,
        config: asNonArrayRecord(memory.honcho),
      },
    };
    addConfigPatch({
      id: "config:memory-plugin:honcho",
      target: "plugins.entries.honcho",
      path: ["plugins", "entries"],
      value,
      message: "Preserve Hermes Honcho memory settings as a plugin entry for manual activation.",
    });
    configItems.push(
      createMigrationManualItem({
        id: "manual:memory-provider:honcho",
        source: "config.yaml:memory.provider",
        message:
          "Hermes used Honcho memory. OpenClaw keeps built-in memory selected until the matching plugin is installed and reviewed.",
        recommendation:
          "Install or review the Honcho memory plugin before selecting it for plugins.slots.memory.",
      }),
    );
  } else if (memoryProvider && !["builtin", "file", "files"].includes(memoryProvider)) {
    configItems.push(
      createMigrationManualItem({
        id: `manual:memory-provider:${memoryProvider}`,
        source: "config.yaml:memory.provider",
        message: `Hermes memory provider "${memoryProvider}" does not have a known OpenClaw mapping.`,
        recommendation: "Install or configure an equivalent OpenClaw memory plugin manually.",
      }),
    );
  }

  const providers = collectHermesProviders(config, env, Boolean(ctx.includeSecrets));
  addSelectedModelToProvider(providers, modelRef);
  for (const provider of providers) {
    const value = { [provider.id]: providerConfig(provider) };
    addConfigPatch({
      id: `config:model-provider:${sanitizeName(provider.id)}`,
      target: `models.providers.${provider.id}`,
      path: ["models", "providers"],
      value,
      message: `Import Hermes provider and custom endpoint config for "${provider.id}".`,
      sensitive: provider.sensitive,
    });
  }
  configItems.push(...providerManualItems(config, env ?? {}, Boolean(ctx.includeSecrets)));

  const mcpConfig = config.mcp;
  const rawMcpServers =
    config.mcp_servers ??
    (isRecord(mcpConfig) && isRecord(mcpConfig.servers) ? mcpConfig.servers : mcpConfig);
  const rawMcpSource =
    config.mcp_servers !== undefined
      ? "config.yaml:mcp_servers"
      : isRecord(mcpConfig) && isRecord(mcpConfig.servers)
        ? "config.yaml:mcp.servers"
        : "config.yaml:mcp";
  if (isRecord(rawMcpServers)) {
    // Hermes loads process env first, then lets its source .env override those values.
    const mcpEnv = { ...runtimeEnv, ...env };
    for (const [name, rawServer] of Object.entries(rawMcpServers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      const {
        server,
        sensitive,
        items: manualItems,
      } = planHermesMcpServer({
        name,
        raw: rawServer,
        includeSecrets: Boolean(ctx.includeSecrets),
        env: mcpEnv,
        source: `${rawMcpSource}.${name}`,
      });
      if (Object.keys(server).length > 0) {
        const value = { [name]: server };
        addConfigPatch({
          id: `config:mcp-server:${sanitizeName(name)}`,
          target: `mcp.servers.${name}`,
          path: ["mcp", "servers"],
          value,
          message: `Import Hermes MCP server definition "${name}".`,
          sensitive,
        });
      }
      configItems.push(...manualItems);
    }
  }

  for (const [skillKey, value] of Object.entries(mapSkillEntries(config))) {
    const configPath = ["skills", "entries", skillKey];
    addConfigPatch({
      id: `config:skill-entry:${sanitizeName(skillKey)}`,
      target: configPath.join("."),
      path: configPath,
      value,
      message: "Import Hermes skill config values and global disabled state.",
    });
  }
  if (modelRef && modelItemIndex !== undefined) {
    const modelItem = items[modelItemIndex];
    const dependency = findHermesModelProviderDependency(configItems, modelRef);
    if (modelItem?.status === "planned" && dependency?.status === "conflict") {
      items[modelItemIndex] = markMigrationItemConflict(
        modelItem,
        HERMES_REASON_MODEL_PROVIDER_CONFLICT,
      );
    }
  }
  items.push(...configItems);

  for (const [filename, sourcePath] of [
    ["SOUL.md", source.soulPath],
    ["AGENTS.md", source.agentsPath],
  ] as const) {
    if (!sourcePath) {
      continue;
    }
    const target = path.join(targets.workspaceDir, filename);
    const conflict = (await exists(target)) && !ctx.overwrite;
    items.push(
      createMigrationItem({
        id: `workspace:${filename}`,
        kind: "workspace",
        action: "copy",
        source: sourcePath,
        target,
        status: conflict ? "conflict" : "planned",
        reason: conflict ? MIGRATION_REASON_TARGET_EXISTS : undefined,
      }),
    );
  }
  for (const [filename, sourcePath] of [
    ["MEMORY.md", source.memoryPath],
    ["USER.md", source.userPath],
  ] as const) {
    if (sourcePath) {
      items.push(
        createMigrationItem({
          id: `memory:${filename}`,
          kind: "memory",
          action: "append",
          source: sourcePath,
          target: path.join(targets.workspaceDir, filename),
        }),
      );
    }
  }
  items.push(...(await buildSkillItems({ source, targets, overwrite: ctx.overwrite })));
  const authItems = await buildAuthItems({ ctx, source, targets });
  if (
    usesRetiredHermesQwenProvider(config) &&
    !authItems.some((item) => item.id === "manual:auth-reauthenticate:qwen")
  ) {
    authItems.unshift(
      createMigrationManualItem({
        id: "manual:auth-reauthenticate:qwen",
        source: source.configPath ?? source.root,
        message: "Hermes Qwen Portal OAuth and Qwen CLI credentials cannot be reused by OpenClaw.",
        recommendation:
          "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
      }),
    );
  }
  items.push(...authItems);
  items.push(...(await buildSecretItems({ config, ctx, source, targets })));
  for (const archivePath of source.archivePaths) {
    items.push(
      createMigrationItem({
        id: archivePath.id,
        kind: "archive",
        action: "archive",
        source: archivePath.path,
        message:
          "Archived in the migration report for manual review; not imported into live config.",
        details: { archiveRelativePath: archivePath.relativePath },
      }),
    );
  }

  const warnings = [
    ...(!ctx.includeSecrets && items.some((item) => item.kind === "secret" || item.kind === "auth")
      ? [
          "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
        ]
      : []),
    ...(items.some(
      (item) => item.kind === "auth" && item.details?.sourceKind === "hermes-auth-json",
    )
      ? [
          "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
        ]
      : []),
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
        ]
      : []),
    ...(source.archivePaths.length > 0
      ? [
          "Some Hermes files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw.",
        ]
      : []),
    ...(items.some((item) => item.kind === "manual")
      ? ["Some Hermes settings require manual review before they can be activated safely."]
      : []),
  ];
  return {
    providerId: "hermes",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: ["Run openclaw doctor after applying the migration."],
    metadata: { agentDir: targets.agentDir },
  };
}
