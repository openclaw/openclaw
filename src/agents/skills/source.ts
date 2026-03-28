import type { Skill } from "@mariozechner/pi-coding-agent";

type SkillSourceShapeCompat = Skill & {
  source?: string;
  sourceInfo?: {
    source?: string;
  };
};

export function resolveSkillSource(skill: Skill): string {
  const compatSkill = skill as SkillSourceShapeCompat;
  return compatSkill.source ?? compatSkill.sourceInfo?.source ?? "unknown";
}
