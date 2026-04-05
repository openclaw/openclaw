import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

type DreamingMode = "off" | "core" | "rem" | "deep";

const DREAMING_MODE_LIST = [
  "off",
  "core",
  "rem",
  "deep",
] as const satisfies readonly DreamingMode[];
const DEFAULT_DREAMING_MODE: DreamingMode = "off";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDreamingMode(value: unknown): DreamingMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "rem" ||
    normalized === "deep"
  ) {
    return normalized;
  }
  return null;
}

function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

function resolveDreamingModeFromConfig(pluginConfig: Record<string, unknown>): DreamingMode {
  const dreaming = asRecord(pluginConfig.dreaming);
  return normalizeDreamingMode(dreaming?.mode) ?? DEFAULT_DREAMING_MODE;
}

function updateDreamingModeInConfig(cfg: OpenClawConfig, mode: DreamingMode): OpenClawConfig {
  const entries = { ...(cfg.plugins?.entries ?? {}) };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingDreaming = asRecord(existingConfig.dreaming) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      dreaming: {
        ...existingDreaming,
        mode,
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

function formatModeGuideLine(mode: DreamingMode): string {
  if (mode === "off") {
    return "- off: disable automatic short-term to long-term promotion.";
  }
  const resolved = resolveShortTermPromotionDreamingConfig({
    pluginConfig: {
      dreaming: {
        mode,
      },
    },
  });
  return (
    `- ${mode}: cadence=${resolved.cron}; ` +
    `minScore=${resolved.minScore}, minRecallCount=${resolved.minRecallCount}, ` +
    `minUniqueQueries=${resolved.minUniqueQueries}.`
  );
}

function formatModeGuide(): string {
  return DREAMING_MODE_LIST.map((mode) => formatModeGuideLine(mode)).join("\n");
}

function formatStatus(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg);
  const mode = resolveDreamingModeFromConfig(pluginConfig);
  const resolved = resolveShortTermPromotionDreamingConfig({
    pluginConfig,
    cfg,
  });
  const cadence = resolved.enabled ? resolved.cron : "disabled";
  const timezone = resolved.enabled && resolved.timezone ? ` (${resolved.timezone})` : "";

  return [
    "Dreaming status:",
    `- mode: ${mode}`,
    `- cadence: ${cadence}${timezone}`,
    `- limit: ${resolved.limit}`,
    `- thresholds: minScore=${resolved.minScore}, minRecallCount=${resolved.minRecallCount}, minUniqueQueries=${resolved.minUniqueQueries}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming off|core|rem|deep",
    "Use /dreaming status for current settings.",
    "",
    includeStatus,
    "",
    "Modes:",
    formatModeGuide(),
  ].join("\n");
}

export function registerDreamingCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "dreaming",
    description: "Configure memory dreaming mode (off|core|rem|deep).",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const firstToken = args.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
      const currentConfig = api.runtime.config.loadConfig();

      if (
        !firstToken ||
        firstToken === "help" ||
        firstToken === "options" ||
        firstToken === "modes"
      ) {
        return { text: formatUsage(formatStatus(currentConfig)) };
      }

      if (firstToken === "status") {
        return { text: formatStatus(currentConfig) };
      }

      const requestedMode = normalizeDreamingMode(firstToken);
      if (!requestedMode) {
        return { text: formatUsage(formatStatus(currentConfig)) };
      }

      const nextConfig = updateDreamingModeInConfig(currentConfig, requestedMode);
      await api.runtime.config.writeConfigFile(nextConfig);

      return {
        text: [
          `Dreaming mode set to ${requestedMode}.`,
          "",
          formatStatus(nextConfig),
          "",
          "Modes:",
          formatModeGuide(),
        ].join("\n"),
      };
    },
  });
}
