import path from "node:path";
import type { SkillsWorkshopListResult } from "@openclaw/gateway-protocol";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canonicalizePath } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import { listWorkshopDrafts } from "./drafts.js";
import { listWorkshopArchive, listWorkshopSkills } from "./library.js";
import { getWorkshopRuntime } from "./runtime.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

/** Workshop inventory shared by `skills.workshop.list` and the local CLI fallback. */
export async function buildSkillsWorkshopListResult(params: {
  config: OpenClawConfig;
  agentId: string;
}): Promise<SkillsWorkshopListResult> {
  const { config, agentId } = params;
  const root = resolveWorkshopSkillsDir(config, agentId);
  const [skills, archived, drafts] = await Promise.all([
    listWorkshopSkills(config, agentId),
    listWorkshopArchive(config, agentId),
    listWorkshopDrafts(config, agentId),
  ]);
  const withFiles = skills.map((skill) => ({
    skill,
    skillFile: canonicalizePath(path.join(root, skill.name, "SKILL.md")),
  }));
  const { usage } = await getWorkshopRuntime().skills.readUsage({
    skillFiles: withFiles.map(({ skillFile }) => skillFile),
  });
  return {
    agentId,
    mode: resolveSkillWorkshopConfig(config).autonomous.mode,
    root,
    skills: withFiles.map(({ skill, skillFile }) => Object.assign(skill, usage.get(skillFile))),
    archived,
    drafts: drafts.map((draft) => ({
      id: draft.id,
      skillName: draft.skillName,
      summary: draft.reason ?? draft.description,
      createdAtMs: draft.createdAtMs,
    })),
  };
}
