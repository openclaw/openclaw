import * as os from "node:os";
import * as path from "node:path";
import type { PluginInsightsConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

export function resolveConfig(
  userConfig: Partial<PluginInsightsConfig> | undefined,
): PluginInsightsConfig {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  if (userConfig?.llmJudge) {
    config.llmJudge = { ...DEFAULT_CONFIG.llmJudge, ...userConfig.llmJudge };
  }

  config.dbPath = resolveDbPath(config.dbPath);
  return config;
}

export function resolveDbPath(dbPath: string): string {
  if (dbPath.startsWith("~")) {
    return path.join(os.homedir(), dbPath.slice(1));
  }
  return path.resolve(dbPath);
}
