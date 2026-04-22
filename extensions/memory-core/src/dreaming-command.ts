import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { applyDreamingMaintenance, rollbackDreamingMaintenance } from "./dreaming-maintenance.js";
import { asRecord } from "./dreaming-shared.js";
import {
  resolveDreamingBlockedReason,
  resolveShortTermPromotionDreamingConfig,
} from "./dreaming.js";

function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

function updateDreamingEnabledInConfig(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingSleep = asRecord(existingConfig.dreaming) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      dreaming: {
        ...existingSleep,
        enabled,
      },
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatPhaseGuide(): string {
  return [
    "- implementation detail: each sweep runs light -> REM -> deep.",
    "- deep stages durable maintenance by default; it does not write MEMORY.md until apply.",
    "- /dreaming apply writes the staged managed block; /dreaming rollback reverts the last apply.",
    "- DREAMS.md is for human-readable dreaming summaries and diary entries.",
  ].join("\n");
}

function formatStatus(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg);
  const dreaming = resolveMemoryDreamingConfig({
    pluginConfig,
    cfg,
  });
  const deep = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";
  const blockedReason = resolveDreamingBlockedReason(cfg);

  return [
    "Dreaming status:",
    `- enabled: ${formatEnabled(dreaming.enabled)}${timezone}`,
    ...(blockedReason ? [`- blocked: ${blockedReason}`] : []),
    `- sweep cadence: ${dreaming.frequency}`,
    `- daily signals: ${dreaming.dailySignalFiles.join(", ")}`,
    `- maintenance: ${dreaming.maintenance.autoApply ? "auto-apply" : "stage-only"} (maxManagedEntries=${dreaming.maintenance.maxManagedEntries}, staleAfterDays=${dreaming.maintenance.staleAfterDays})`,
    `- promotion policy: score>=${deep.minScore}, recalls>=${deep.minRecallCount}, uniqueQueries>=${deep.minUniqueQueries}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming status",
    "Usage: /dreaming on|off",
    "Usage: /dreaming apply|rollback",
    "",
    includeStatus,
    "",
    "Phases:",
    formatPhaseGuide(),
  ].join("\n");
}

async function mutateDreamingMaintenanceAcrossWorkspaces(params: {
  cfg: OpenClawConfig;
  action: "apply" | "rollback";
}): Promise<string> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  if (workspaces.length === 0) {
    return `Dreaming ${params.action}: no memory workspace is configured.`;
  }
  const lines = [`Dreaming ${params.action}:`];
  for (const workspace of workspaces) {
    const outcome =
      params.action === "apply"
        ? await applyDreamingMaintenance({ workspaceDir: workspace.workspaceDir })
        : await rollbackDreamingMaintenance({ workspaceDir: workspace.workspaceDir });
    if (outcome.status === "applied" || outcome.status === "rolled_back") {
      lines.push(
        `- ${workspace.workspaceDir}: ${outcome.status} (${outcome.reportId}) [${outcome.touchedFiles.join(", ")}]`,
      );
      continue;
    }
    if (outcome.status === "conflict") {
      lines.push(`- ${workspace.workspaceDir}: conflict on ${outcome.path}`);
      continue;
    }
    lines.push(`- ${workspace.workspaceDir}: ${outcome.reason}`);
  }
  return lines.join("\n");
}

function requiresAdminToMutateDreaming(gatewayClientScopes?: readonly string[]): boolean {
  return Array.isArray(gatewayClientScopes) && !gatewayClientScopes.includes("operator.admin");
}

export function registerDreamingCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "dreaming",
    description: "Enable or disable memory dreaming.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const [firstToken = ""] = args
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => normalizeLowercaseStringOrEmpty(token));
      const currentConfig = api.runtime.config.loadConfig();

      if (
        !firstToken ||
        firstToken === "help" ||
        firstToken === "options" ||
        firstToken === "phases"
      ) {
        return { text: formatUsage(formatStatus(currentConfig)) };
      }

      if (firstToken === "status") {
        return { text: formatStatus(currentConfig) };
      }

      if (firstToken === "on" || firstToken === "off") {
        if (requiresAdminToMutateDreaming(ctx.gatewayClientScopes)) {
          return { text: "⚠️ /dreaming on|off requires operator.admin for gateway clients." };
        }
        const enabled = firstToken === "on";
        const nextConfig = updateDreamingEnabledInConfig(currentConfig, enabled);
        await api.runtime.config.writeConfigFile(nextConfig);
        return {
          text: [
            `Dreaming ${enabled ? "enabled" : "disabled"}.`,
            "",
            formatStatus(nextConfig),
          ].join("\n"),
        };
      }

      if (firstToken === "apply" || firstToken === "rollback") {
        if (requiresAdminToMutateDreaming(ctx.gatewayClientScopes)) {
          return {
            text: "⚠️ /dreaming apply|rollback requires operator.admin for gateway clients.",
          };
        }
        return {
          text: await mutateDreamingMaintenanceAcrossWorkspaces({
            cfg: currentConfig,
            action: firstToken,
          }),
        };
      }

      return { text: formatUsage(formatStatus(currentConfig)) };
    },
  });
}
