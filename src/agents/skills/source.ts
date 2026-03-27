import type { Skill } from "@mariozechner/pi-coding-agent";

export function resolveSkillSource(skill: Skill): string {
  return skill.sourceInfo.source;
}
