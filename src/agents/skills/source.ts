import type { Skill } from "@mariozechner/pi-coding-agent";

export function resolveSkillSource(skill: Skill): string {
  const source = (skill as Skill & { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}
