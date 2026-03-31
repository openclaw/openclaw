import * as fs from "node:fs";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { loadWorkspaceSkillEntries, type SkillEntry, type SkillSnapshot } from "../skills.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "../skills/frontmatter.js";
import { resolveSkillRuntimeConfig } from "../skills/runtime-config.js";

/**
 * Build SkillEntry objects from an already-resolved Skill list by reading
 * each SKILL.md file.  Used when a cached skillsSnapshot skips the full
 * directory scan, so that model-routing and other metadata-dependent features
 * still have access to the parsed frontmatter.
 */
function buildSkillEntriesFromResolvedSkills(skills: Skill[]): SkillEntry[] {
  return skills.map((skill) => {
    let frontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore unreadable skill files
    }
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
}

export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);

  if (!shouldLoadSkillEntries && params.skillsSnapshot?.resolvedSkills) {
    // Build SkillEntry objects from the cached Skill list so that features
    // like skill-level model routing can read frontmatter metadata even when
    // the full skill-directory scan is skipped.
    return {
      shouldLoadSkillEntries: false,
      skillEntries: buildSkillEntriesFromResolvedSkills(params.skillsSnapshot.resolvedSkills),
    };
  }

  return {
    shouldLoadSkillEntries: true,
    skillEntries: loadWorkspaceSkillEntries(params.workspaceDir, { config }),
  };
}
