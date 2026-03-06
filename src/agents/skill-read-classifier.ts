/**
 * Classify a file read path as a skill-related access.
 *
 * Given the resolved skills from the current workspace snapshot,
 * determines whether a read tool call targets a skill entry point
 * (SKILL.md) or a sub-file within a skill directory.
 */

import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";

export type SkillReadClassification =
  | {
      isSkillRead: true;
      skillName: string;
      skillBaseDir: string;
      /**
       * "entry" — the SKILL.md file itself (the agent is activating this skill).
       * "sub"   — a supporting file within the skill directory.
       */
      readType: "entry" | "sub";
      /** The normalized path that was read. */
      filePath: string;
    }
  | {
      isSkillRead: false;
    };

/**
 * Classify a file read path against the loaded skill set.
 *
 * @param filePath - The path the agent is reading (may use `~` or be absolute).
 * @param skills  - The resolved skills from the workspace snapshot.
 * @param homeDir - The user's home directory for `~` expansion.
 */
export function classifySkillRead(
  filePath: string,
  skills: Skill[],
  homeDir?: string,
): SkillReadClassification {
  if (!filePath || skills.length === 0) {
    return { isSkillRead: false };
  }

  // Normalize ~ to home directory
  let normalized = filePath;
  if (homeDir && normalized.startsWith("~/")) {
    normalized = path.join(homeDir, normalized.slice(2));
  }
  normalized = path.resolve(normalized);

  for (const skill of skills) {
    const skillDir = path.resolve(skill.baseDir);
    const skillMd = path.resolve(skill.filePath);

    // Check if the file is within this skill's directory
    if (
      !normalized.startsWith(skillDir + path.sep) &&
      normalized !== skillDir &&
      normalized !== skillMd
    ) {
      continue;
    }

    // Determine if this is the SKILL.md entry point or a sub-file
    const isEntry = normalized === skillMd || normalized.endsWith(path.sep + "SKILL.md");

    return {
      isSkillRead: true,
      skillName: skill.name,
      skillBaseDir: skillDir,
      readType: isEntry ? "entry" : "sub",
      filePath: normalized,
    };
  }

  return { isSkillRead: false };
}
