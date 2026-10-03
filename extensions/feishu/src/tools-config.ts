import type { FeishuToolsConfig } from "./types.js";

/**
 * Default tool configuration.
 * - doc, chat, wiki, drive, scopes, bitable: enabled by default
 * - perm: disabled by default (sensitive operation)
 */
const DEFAULT_TOOLS_CONFIG: Required<FeishuToolsConfig> = {
  doc: true,
  chat: true,
  wiki: true,
  drive: true,
  perm: false,
  scopes: true,
  bitable: true,
};

export function resolveToolsConfig(cfg?: FeishuToolsConfig): Required<FeishuToolsConfig> {
  return { ...DEFAULT_TOOLS_CONFIG, ...cfg };
}
