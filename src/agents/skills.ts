import path from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@mariozechner/pi-coding-agent";

export function buildWorkspaceSkillsPrompt(workspaceDir: string): string {
  const skillsDir = path.join(workspaceDir, "skills");
  const skills = loadSkillsFromDir({
    dir: skillsDir,
    source: "clawdis-workspace",
  });
  return formatSkillsForPrompt(skills);
}
