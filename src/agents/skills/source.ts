import type { Skill } from "@mariozechner/pi-coding-agent";

type SkillSourceCompat = Skill & {
  sourceInfo?: {
    source?: string;
  };
};

export function resolveSkillSource(skill: Skill): string {
  const compatSkill = skill as SkillSourceCompat;
  const canonical = typeof compatSkill.source === "string" ? compatSkill.source.trim() : "";
  if (canonical) {
    return canonical;
  }
  const legacy =
    typeof compatSkill.sourceInfo?.source === "string" ? compatSkill.sourceInfo.source.trim() : "";
  return legacy || "unknown";
}
