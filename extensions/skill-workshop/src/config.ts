import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** How background reviews may change Workshop skills. */
type SkillsWorkshopAutonomousMode = "off" | "propose" | "auto";

/** Runtime configuration for Skill Workshop. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
    channelNotices: boolean;
  };
  maxSkillBytes: number;
};

function isMode(value: unknown): value is SkillsWorkshopAutonomousMode {
  return value === "off" || value === "propose" || value === "auto";
}

/**
 * Reads the bundled plugin's own settings (`plugins.entries.skill-workshop.config`); its manifest
 * schema validates them. Doctor moves the retired core `skills.workshop` key here.
 */
export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = config?.plugins?.entries?.["skill-workshop"]?.config;
  const autonomous = isRecord(raw?.autonomous) ? raw.autonomous : undefined;
  const maxSkillBytes = typeof raw?.maxSkillBytes === "number" ? raw.maxSkillBytes : 40_000;
  return {
    autonomous: {
      mode: isMode(autonomous?.mode) ? autonomous.mode : "auto",
      channelNotices: autonomous?.channelNotices === true,
    },
    maxSkillBytes: Math.min(Math.max(maxSkillBytes, 1024), 200_000),
  };
}
