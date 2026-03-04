import type { FeishuToolsConfig } from "./types.js";

/**
 * Default tool configuration.
 * - doc, chat, wiki, drive, scopes, message: enabled by default
 * - perm, task: disabled by default (sensitive / write operations)
 */
export const DEFAULT_TOOLS_CONFIG: Required<FeishuToolsConfig> = {
  doc: true,
  chat: true,
  message: true,
  wiki: true,
  drive: true,
  perm: false,
  scopes: true,
  task: false,
};

/**
 * Resolve tools config with defaults.
 */
export function resolveToolsConfig(cfg?: FeishuToolsConfig): Required<FeishuToolsConfig> {
  return { ...DEFAULT_TOOLS_CONFIG, ...cfg };
}
