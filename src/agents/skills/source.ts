import type { Skill } from "@mariozechner/pi-coding-agent";

type SkillSourceShapeCompat = Skill & {
  source?: string;
  sourceInfo?: {
    source?: string;
  };
};

export function resolveSkillSource(skill: Skill): string {
  const compatSkill = skill as SkillSourceShapeCompat;
  const sourceInfoSource =
    typeof compatSkill.sourceInfo?.source === "string" ? compatSkill.sourceInfo.source.trim() : "";
  if (sourceInfoSource) {
    return sourceInfoSource;
  }
  const legacySource = typeof compatSkill.source === "string" ? compatSkill.source.trim() : "";
  return legacySource || "unknown";
}
