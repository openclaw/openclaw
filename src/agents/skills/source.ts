import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { Skill } from "./skill-contract.js";

type SkillSourceCompat = Skill & {
  sourceInfo?: {
    source?: string;
  };
};

export function resolveSkillSource(skill: Skill): string {
  const compatSkill = skill as SkillSourceCompat;
  const canonical = normalizeOptionalString(compatSkill.source) ?? "";
  if (canonical) {
    return canonical;
  }
  const legacy = normalizeOptionalString(compatSkill.sourceInfo?.source) ?? "";
  return legacy || "unknown";
}
