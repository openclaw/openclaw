import type { Skill } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

export type LazySkillLoadingConfig = {
  enabled: boolean;
};

export function resolveLazySkillLoadingConfig(cfg?: OpenClawConfig): LazySkillLoadingConfig {
  const raw = cfg?.agents?.defaults?.skills;
  return {
    enabled: (raw as { lazyLoading?: boolean } | undefined)?.lazyLoading ?? false,
  };
}

/**
 * Build a compact skill index for the system prompt.
 * Instead of including full SKILL.md content for every skill (~15k tokens),
 * only include name + one-line description per skill.
 *
 * The agent can call `load_skill` to get full content on demand.
 */
export function buildCompactSkillIndex(skills: SkillEntry[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = [
    "# Available Skills",
    "",
    "Use `load_skill` tool with the skill name to load full instructions.",
    "",
  ];

  for (const entry of skills) {
    const name = entry.skill.name;
    const description = entry.skill.description?.trim() || "No description";
    lines.push(`- **${name}**: ${description}`);
  }

  return lines.join("\n");
}

/**
 * Build a compact skill prompt that replaces the full skill injection.
 * Returns the compact index string instead of the full skill content.
 */
export function buildLazySkillsPrompt(params: {
  entries: SkillEntry[];
  config?: OpenClawConfig;
}): string {
  const lazyConfig = resolveLazySkillLoadingConfig(params.config);
  if (!lazyConfig.enabled) {
    return "";
  }
  return buildCompactSkillIndex(params.entries);
}

/**
 * Resolve the full content for a specific skill by name.
 * Used by the load_skill meta-tool.
 */
export function resolveSkillContent(
  skillName: string,
  resolvedSkills: Skill[] | undefined,
): { content: string; found: boolean } {
  if (!resolvedSkills || resolvedSkills.length === 0) {
    return { content: `Skill "${skillName}" not found. No skills available.`, found: false };
  }

  const normalized = skillName.trim().toLowerCase();
  const match = resolvedSkills.find((skill) => skill.name.toLowerCase() === normalized);

  if (!match) {
    const available = resolvedSkills.map((s) => s.name).join(", ");
    return {
      content: `Skill "${skillName}" not found. Available skills: ${available}`,
      found: false,
    };
  }

  try {
    const raw = fs.readFileSync(match.filePath, "utf-8");
    return { content: raw || `Skill "${match.name}" has no content.`, found: true };
  } catch {
    return { content: `Skill "${match.name}" could not be loaded.`, found: false };
  }
}

/**
 * Create a SkillSnapshot that uses the compact index instead of full content.
 * The resolvedSkills are still stored for on-demand loading.
 */
export function buildLazySkillSnapshot(params: {
  entries: SkillEntry[];
  resolvedSkills: Skill[];
  config?: OpenClawConfig;
  snapshotVersion?: number;
}): SkillSnapshot {
  const compactPrompt = buildCompactSkillIndex(params.entries);

  return {
    prompt: compactPrompt,
    skills: params.entries.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
    })),
    resolvedSkills: params.resolvedSkills,
    version: params.snapshotVersion,
  };
}
