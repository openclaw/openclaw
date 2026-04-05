import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
  resolveMemoryDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

type DreamingPhaseName = "light" | "deep" | "rem";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDreamingPhase(value: unknown): DreamingPhaseName | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "light" || normalized === "deep" || normalized === "rem") {
    return normalized;
  }
  return null;
}

function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

function updateDreamingEnabledInConfig(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const entries = { ...(cfg.plugins?.entries ?? {}) };
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

function updateDreamingPhaseEnabledInConfig(
  cfg: OpenClawConfig,
  phase: DreamingPhaseName,
  enabled: boolean,
): OpenClawConfig {
  const entries = { ...(cfg.plugins?.entries ?? {}) };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingSleep = asRecord(existingConfig.dreaming) ?? {};
  const existingPhases = asRecord(existingSleep.phases) ?? {};
  const existingPhase = asRecord(existingPhases[phase]) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      dreaming: {
        ...existingSleep,
        phases: {
          ...existingPhases,
          [phase]: {
            ...existingPhase,
            enabled,
          },
        },
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
    "- light: sorts recent memory traces into the daily note.",
    "- deep: promotes durable memories into MEMORY.md and handles recovery when memory is thin.",
    "- rem: writes reflection and pattern notes into the daily note.",
  ].join("\n");
}

function formatStatus(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg);
  const dreaming = resolveMemoryDreamingConfig({
    pluginConfig,
    cfg,
  });
  const deep = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg });
  const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg });
  const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";

  return [
    "Dreaming status:",
    `- enabled: ${formatEnabled(dreaming.enabled)}${timezone}`,
    `- storage: ${dreaming.storage.mode}${dreaming.storage.separateReports ? " + reports" : ""}`,
    `- verboseLogging: ${formatEnabled(dreaming.verboseLogging)}`,
    `- light: ${formatEnabled(light.enabled)} · cadence=${light.enabled ? light.cron : "disabled"} · lookbackDays=${light.lookbackDays} · limit=${light.limit}`,
    `- deep: ${formatEnabled(deep.enabled)} · cadence=${deep.enabled ? deep.cron : "disabled"} · limit=${deep.limit} · minScore=${deep.minScore} · minRecallCount=${deep.minRecallCount} · minUniqueQueries=${deep.minUniqueQueries} · recencyHalfLifeDays=${deep.recencyHalfLifeDays} · maxAgeDays=${deep.maxAgeDays ?? "none"}`,
    `- rem: ${formatEnabled(rem.enabled)} · cadence=${rem.enabled ? rem.cron : "disabled"} · lookbackDays=${rem.lookbackDays} · limit=${rem.limit} · minPatternStrength=${rem.minPatternStrength}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming status",
    "Usage: /dreaming on|off",
    "Usage: /dreaming enable light|deep|rem",
    "Usage: /dreaming disable light|deep|rem",
    "",
    includeStatus,
    "",
    "Phases:",
    formatPhaseGuide(),
  ].join("\n");
}

export function registerDreamingCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "dreaming",
    description: "Configure memory dreaming phases and durable promotion behavior.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const [firstToken = "", secondToken = ""] = args
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.toLowerCase());
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

      const phase = normalizeDreamingPhase(secondToken);
      if ((firstToken === "enable" || firstToken === "disable") && phase) {
        const enabled = firstToken === "enable";
        const nextConfig = updateDreamingPhaseEnabledInConfig(currentConfig, phase, enabled);
        await api.runtime.config.writeConfigFile(nextConfig);
        return {
          text: [
            `${phase.toUpperCase()} phase ${enabled ? "enabled" : "disabled"}.`,
            "",
            formatStatus(nextConfig),
          ].join("\n"),
        };
      }

      return { text: formatUsage(formatStatus(currentConfig)) };
    },
  });
}
