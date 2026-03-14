import type { FeishuToolsConfig } from "./types.js";

/**
 * Default tool configuration.
 * - doc, chat, wiki, drive, scopes: enabled by default
 * - perm: disabled by default (sensitive operation)
 * - urgent: disabled by default (opt-in; requires im:message.urgent scope)
 */
export const DEFAULT_TOOLS_CONFIG: Required<FeishuToolsConfig> = {
  doc: true,
  chat: true,
  wiki: true,
  drive: true,
  perm: false,
  scopes: true,
  urgent: false,
};

/**
 * Resolve tools config with defaults.
 */
export function resolveToolsConfig(cfg?: FeishuToolsConfig): Required<FeishuToolsConfig> {
  return { ...DEFAULT_TOOLS_CONFIG, ...cfg };
}
