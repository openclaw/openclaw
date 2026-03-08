/**
 * Classify file-read tool calls as skill-related or not.
 * Detects SKILL.md entry reads vs sub-file reads within a skill directory.
 */

export type SkillClassification =
  | { isSkill: false }
  | { isSkill: true; skill: string; skillType: "entry" | "sub" };

const SKILL_DIR_PATTERNS = [
  // <workspace>/skills/<name>/
  /\/skills\/([^/]+)\//,
  // <workspace>/.agents/skills/<name>/
  /\/.agents\/skills\/([^/]+)\//,
  // ~/.openclaw/skills/<name>/
  /\/\.openclaw\/skills\/([^/]+)\//,
];

const SKILL_ENTRY_FILE = "SKILL.md";

/**
 * Classify a file path from a read tool call.
 *
 * @param filePath - The path being read
 * @returns classification with skill name and type if applicable
 */
export function classifyReadPath(filePath: string): SkillClassification {
  if (!filePath) {
    return { isSkill: false };
  }

  for (const pattern of SKILL_DIR_PATTERNS) {
    const match = pattern.exec(filePath);
    if (!match) {
      continue;
    }

    const skill = match[1];
    const isEntry = filePath.endsWith(`/${SKILL_ENTRY_FILE}`);

    return {
      isSkill: true,
      skill,
      skillType: isEntry ? "entry" : "sub",
    };
  }

  return { isSkill: false };
}
