import { readFile } from "node:fs/promises";
import type { Skill } from "../skills/loading/skill-contract.js";
import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";

export type CodeModeSkill = {
  name: string;
  description: string;
  location: string;
  source: Pick<Skill, "filePath" | "readContent">;
  reader?: CodeModeSkillReader;
};

export type CodeModeSkillReader = (params: {
  location: string;
  signal?: AbortSignal;
}) => Promise<string>;

/** Select Code Mode skills from the exact catalog rendered into this run's prompt. */
export function resolveCodeModeSkills(params: {
  skillsPrompt: string;
  candidates: readonly Skill[];
  reader?: CodeModeSkillReader;
}): CodeModeSkill[] {
  const catalog = parseSkillsPromptCatalog(params.skillsPrompt);
  if (catalog.length === 0) {
    return [];
  }
  const candidatesByName = new Map(params.candidates.map((skill) => [skill.name, skill]));
  const result: CodeModeSkill[] = [];
  for (const { name, location } of catalog) {
    const source = candidatesByName.get(name);
    if (!source) {
      continue;
    }
    result.push({
      name,
      description: [source.description, source.locationNote].filter(Boolean).join("\n"),
      location,
      source: {
        filePath: source.filePath,
        readContent: source.readContent,
      },
      reader: params.reader,
    });
  }
  return result;
}

export async function readCodeModeSkill(
  skill: CodeModeSkill,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof skill.source.readContent === "string") {
    return skill.source.readContent;
  }
  if (skill.reader) {
    return await skill.reader({ location: skill.location, signal });
  }
  return await readFile(skill.source.filePath, { encoding: "utf8", signal });
}
