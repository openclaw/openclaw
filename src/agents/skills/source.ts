import type { Skill } from "@mariozechner/pi-coding-agent";

export function resolveSkillSource(skill: Skill): string {
  const source = typeof skill.sourceInfo?.source === "string" ? skill.sourceInfo.source.trim() : "";
  return source || "unknown";
}
