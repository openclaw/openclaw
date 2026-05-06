import path from "node:path";
import {
  createMigrationItem,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { exists, sanitizeName } from "./helpers.js";
import {
  discoverCodexSource,
  hasCodexSource,
  type CodexInstalledPluginSource,
  type CodexSkillSource,
} from "./source.js";
import { resolveCodexMigrationTargets } from "./targets.js";

const OPENAI_CURATED_MARKETPLACE = "openai-curated";

type CodexMigrationContext = MigrationProviderContext & {
  plugins?: string[];
};

function uniqueSkillName(skill: CodexSkillSource, counts: Map<string, number>): string {
  const base = sanitizeName(skill.name) || "codex-skill";
  if ((counts.get(base) ?? 0) <= 1) {
    return base;
  }
  const parent = sanitizeName(path.basename(path.dirname(skill.source)));
  return sanitizeName(["codex", parent, base].filter(Boolean).join("-")) || base;
}

async function buildSkillItems(params: {
  skills: CodexSkillSource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const baseCounts = new Map<string, number>();
  for (const skill of params.skills) {
    const base = sanitizeName(skill.name) || "codex-skill";
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const resolvedCounts = new Map<string, number>();
  const planned = params.skills.map((skill) => {
    const name = uniqueSkillName(skill, baseCounts);
    resolvedCounts.set(name, (resolvedCounts.get(name) ?? 0) + 1);
    return { skill, name, target: path.join(params.workspaceDir, "skills", name) };
  });
  const items: MigrationItem[] = [];
  for (const item of planned) {
    const collides = (resolvedCounts.get(item.name) ?? 0) > 1;
    const targetExists = await exists(item.target);
    items.push(
      createMigrationItem({
        id: `skill:${item.name}`,
        kind: "skill",
        action: "copy",
        source: item.skill.source,
        target: item.target,
        status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
        reason: collides
          ? `multiple Codex skills normalize to "${item.name}"`
          : targetExists && !params.overwrite
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
        details: {
          skillName: item.name,
          sourceLabel: item.skill.sourceLabel,
        },
      }),
    );
  }
  return items;
}

function normalizePluginSelectionRef(value: string): string {
  return sanitizeName(value).replace(new RegExp(`@${OPENAI_CURATED_MARKETPLACE}$`, "u"), "");
}

function readSelectedPlugins(ctx: MigrationProviderContext): Set<string> | undefined {
  const selected = (ctx as CodexMigrationContext).plugins;
  if (!selected || selected.length === 0) {
    return undefined;
  }
  return new Set(
    selected
      .map((plugin) => normalizePluginSelectionRef(plugin))
      .filter((plugin) => plugin.length > 0),
  );
}

function codexPluginKey(plugin: CodexInstalledPluginSource): string {
  return sanitizeName(plugin.name) || sanitizeName(plugin.id) || "codex-plugin";
}

function selectCodexPlugins(params: {
  plugins: CodexInstalledPluginSource[];
  selected?: Set<string>;
}): CodexInstalledPluginSource[] {
  if (!params.selected) {
    return params.plugins;
  }
  const availableRefs = new Map<string, CodexInstalledPluginSource>();
  for (const plugin of params.plugins) {
    const refs = [
      plugin.name,
      plugin.id,
      codexPluginKey(plugin),
      plugin.id.replace(new RegExp(`@${OPENAI_CURATED_MARKETPLACE}$`, "u"), ""),
    ];
    for (const ref of refs) {
      availableRefs.set(normalizePluginSelectionRef(ref), plugin);
    }
  }
  const selectedPlugins: CodexInstalledPluginSource[] = [];
  const unknown: string[] = [];
  for (const ref of params.selected) {
    const plugin = availableRefs.get(ref);
    if (!plugin) {
      unknown.push(ref);
      continue;
    }
    if (!selectedPlugins.some((existing) => existing.id === plugin.id)) {
      selectedPlugins.push(plugin);
    }
  }
  if (unknown.length > 0) {
    const available = params.plugins.map((plugin) => plugin.name).toSorted();
    throw new Error(
      `No migratable Codex plugin matched ${unknown.map((item) => `"${item}"`).join(", ")}. Available plugins: ${
        available.length > 0 ? available.join(", ") : "none"
      }.`,
    );
  }
  return selectedPlugins.toSorted((a, b) => a.name.localeCompare(b.name));
}

function buildCodexPluginsConfig(
  plugins: readonly CodexInstalledPluginSource[],
): Record<string, unknown> {
  return {
    enabled: true,
    allow_destructive_actions: false,
    plugins: {
      "*": {
        enabled: true,
      },
      ...Object.fromEntries(
        plugins.map((plugin) => [
          codexPluginKey(plugin),
          {
            enabled: true,
            marketplaceName: OPENAI_CURATED_MARKETPLACE,
            pluginName: plugin.name,
          },
        ]),
      ),
    },
  };
}

function buildCodexPluginItems(params: {
  ctx: MigrationProviderContext;
  plugins: CodexInstalledPluginSource[];
}): MigrationItem[] {
  if (params.plugins.length === 0) {
    return [];
  }
  const items: MigrationItem[] = [];
  for (const plugin of params.plugins) {
    items.push(
      createMigrationItem({
        id: `plugin:${codexPluginKey(plugin)}`,
        kind: "plugin",
        action: "install",
        source: `${OPENAI_CURATED_MARKETPLACE}:${plugin.name}`,
        status: "planned",
        message: `Activate Codex plugin "${plugin.displayName}" through Codex app-server.`,
        details: {
          pluginId: plugin.id,
          pluginName: plugin.name,
          displayName: plugin.displayName,
          marketplaceName: OPENAI_CURATED_MARKETPLACE,
          ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : {}),
          sourceInstalled: plugin.installed,
          sourceEnabled: plugin.enabled,
          ...(plugin.accessible !== undefined ? { accessible: plugin.accessible } : {}),
        },
      }),
    );
  }
  const value = buildCodexPluginsConfig(params.plugins);
  items.push(
    createMigrationConfigPatchItem({
      id: "config:codex-plugins",
      target: "plugins.entries.codex.config.codexPlugins",
      path: ["plugins", "entries", "codex", "config", "codexPlugins"],
      value,
      message:
        "Enable migrated source-installed openai-curated Codex plugins with destructive actions disabled.",
      conflict:
        !params.ctx.overwrite &&
        hasMigrationConfigPatchConflict(
          params.ctx.config,
          ["plugins", "entries", "codex", "config", "codexPlugins"],
          value,
        ),
    }),
  );
  return items;
}

export async function buildCodexMigrationPlan(
  ctx: MigrationProviderContext,
): Promise<MigrationPlan> {
  const source = await discoverCodexSource(ctx.source, { config: ctx.config });
  if (!hasCodexSource(source)) {
    throw new Error(
      `Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolveCodexMigrationTargets(ctx);
  const items: MigrationItem[] = [];
  items.push(
    ...(await buildSkillItems({
      skills: source.skills,
      workspaceDir: targets.workspaceDir,
      overwrite: ctx.overwrite,
    })),
  );
  const selectedPlugins = selectCodexPlugins({
    plugins: source.codexPlugins,
    selected: readSelectedPlugins(ctx),
  });
  items.push(...buildCodexPluginItems({ ctx, plugins: selectedPlugins }));
  for (const [index, plugin] of source.plugins.entries()) {
    items.push(
      createMigrationManualItem({
        id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${index + 1}`,
        source: plugin.source,
        message: `Codex native plugin "${plugin.name}" was found in the cache scan but not activated automatically.`,
        recommendation:
          "Codex plugin migration can activate source-installed openai-curated plugins only when app-server discovery is available; review other cached plugin bundles manually.",
      }),
    );
  }
  for (const archivePath of source.archivePaths) {
    items.push(
      createMigrationItem({
        id: archivePath.id,
        kind: "archive",
        action: "archive",
        source: archivePath.path,
        message:
          archivePath.message ??
          "Archived in the migration report for manual review; not imported into live config.",
        details: { archiveRelativePath: archivePath.relativePath },
      }),
    );
  }
  const warnings = [
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting skill targets after item-level backups.",
        ]
      : []),
    ...(source.pluginDiscoveryError
      ? [
          `Codex app-server plugin discovery was unavailable (${source.pluginDiscoveryError}). Cached plugin bundles are reported for manual review only.`,
        ]
      : []),
    ...(selectedPlugins.length > 0
      ? [
          "Source-installed openai-curated Codex plugins will be activated through Codex app-server during apply. Plugin bytes are not copied manually.",
        ]
      : []),
    ...(source.plugins.length > 0
      ? [
          "Cached Codex plugin bundles are manual-review fallback items. OpenClaw does not copy plugin bytes or activate non-openai-curated marketplaces.",
        ]
      : []),
    ...(source.archivePaths.length > 0
      ? [
          "Codex config and hook files are archive-only. They are preserved in the migration report, not loaded into OpenClaw automatically.",
        ]
      : []),
  ];
  return {
    providerId: "codex",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: [
      "Run openclaw doctor after applying the migration.",
      "Review skipped Codex plugin/config/hook items before installing or recreating them in OpenClaw.",
    ],
    metadata: {
      agentDir: targets.agentDir,
      codexHome: source.codexHome,
      codexSkillsDir: source.codexSkillsDir,
      personalAgentsSkillsDir: source.personalAgentsSkillsDir,
    },
  };
}
