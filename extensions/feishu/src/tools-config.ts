import type { FeishuToolsConfig } from "./types.js";

// Permission tools default off because they perform sensitive operations.
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
