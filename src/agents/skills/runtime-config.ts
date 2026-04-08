import { getRuntimeConfigSnapshot, type OpenClawConfig } from "../../config/config.js";

export function resolveSkillRuntimeConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  return getRuntimeConfigSnapshot() ?? config;
}
