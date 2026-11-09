// MCP Events doctor contract migrates the shipped callbackOrigin setting to callbackBaseUrl.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const CONFIG_PATH = "plugins.entries.mcp-events.config";

/** Shipped origin-only setting, detected before strict manifest validation. */
export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "mcp-events", "config", "callbackOrigin"],
    message: `${CONFIG_PATH}.callbackOrigin moved to ${CONFIG_PATH}.callbackBaseUrl. Run "openclaw doctor --fix".`,
  },
];

/** Only an origin the shipped setting accepted keeps its callback URL when it becomes a base URL. */
function isShippedOrigin(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

/** Moves the retired origin-only setting; an existing callbackBaseUrl stays authoritative. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const plugins = asObjectRecord(cfg.plugins);
  const entries = asObjectRecord(plugins?.entries);
  const entry = asObjectRecord(entries?.["mcp-events"]);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig || !Object.hasOwn(pluginConfig, "callbackOrigin")) {
    return { config: cfg, changes: [] };
  }
  const { callbackOrigin, ...rest } = pluginConfig;
  // Shipped schemas rejected callbackBaseUrl, so any string here was written for this release.
  const keepBaseUrl = typeof pluginConfig.callbackBaseUrl === "string";
  // An invalid origin never started the plugin; moved as a base URL it could start and misroute.
  // It is removed instead, and an otherwise empty config goes too so a disabled entry validates.
  const invalid = !keepBaseUrl && !isShippedOrigin(callbackOrigin);
  const nextConfig = keepBaseUrl || invalid ? rest : { ...rest, callbackBaseUrl: callbackOrigin };
  const { config: _config, ...entryWithoutConfig } = entry ?? {};
  return {
    config: {
      ...cfg,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          "mcp-events": Object.keys(nextConfig).length
            ? { ...entry, config: nextConfig }
            : entryWithoutConfig,
        },
        // SAFETY: only the mcp-events plugin entry changes; every other entry is copied as read.
      } as OpenClawConfig["plugins"],
    },
    changes: [
      keepBaseUrl
        ? `Removed retired ${CONFIG_PATH}.callbackOrigin; existing ${CONFIG_PATH}.callbackBaseUrl remains authoritative.`
        : invalid
          ? `Removed ${CONFIG_PATH}.callbackOrigin: it was not a valid HTTPS origin. The config backup keeps the old value.`
          : `Moved ${CONFIG_PATH}.callbackOrigin to ${CONFIG_PATH}.callbackBaseUrl.`,
    ],
    ...(invalid
      ? {
          warnings: [
            `Set ${CONFIG_PATH}.callbackBaseUrl to your public HTTPS callback URL; MCP Events can't start without it.`,
          ],
        }
      : {}),
  };
}
