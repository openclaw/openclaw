import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatPhaseGuide(): string {
  return [
    "- implementation detail: each sweep runs light -> REM -> deep.",
    "- deep is the only stage that writes durable entries to MEMORY.md.",
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

  return [
    "Dreaming status:",
    `- enabled: ${formatEnabled(dreaming.enabled)}${timezone}`,
    `- sweep cadence: ${dreaming.frequency}`,
    `- promotion policy: score>=${deep.minScore}, recalls>=${deep.minRecallCount}, uniqueQueries>=${deep.minUniqueQueries}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming status",
    "Usage: /dreaming on|off",
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
    description: "Enable or disable memory dreaming.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const [firstToken = ""] = args
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

      return { text: formatUsage(formatStatus(currentConfig)) };
    },
  });
}
