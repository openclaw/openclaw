import { getRuntimeConfigSnapshot, type MullusiConfig } from "../../config/config.js";

export function resolveSkillRuntimeConfig(config?: MullusiConfig): MullusiConfig | undefined {
  return getRuntimeConfigSnapshot() ?? config;
}
