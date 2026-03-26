import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { TaskProfileId } from "./task-profile.js";

type DynamicSkillPruningReport = NonNullable<SessionSystemPromptReport["skillPruning"]>;

const WEATHER_SIGNAL_PATTERN = /\b(weather|forecast|temperature|rain|snow|humidity)\b/i;
const OPS_SIGNAL_PATTERN =
  /\b(gateway|cron|node|nodes|service|server|deploy|restart|healthcheck|health|log|logs|monitor)\b/i;
const SKILL_AUTHORING_SIGNAL_PATTERN =
  /\b(skill[-_ ]?creator|create (?:a |new )?skill|build (?:a |new )?skill|install (?:a |new )?skill|update (?:a |new )?skill)\b/i;

function buildSkillSearchText(skill: Skill): string {
  return [skill.name, skill.description, skill.filePath, skill.baseDir]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function measureSkillBlockChars(skill: Skill): number {
  const prompt = formatSkillsForPrompt([skill]);
  const block = prompt.match(/<skill>[\s\S]*?<\/skill>/i)?.[0] ?? "";
  return block.length;
}

export function buildEmptyDynamicSkillPruningReport(): DynamicSkillPruningReport {
  return {
    prunedCount: 0,
    prunedBlockChars: 0,
    entries: [],
  };
}

export function pruneSkillsForPrompt(params: {
  skills: Skill[];
  promptText?: string;
  taskProfile?: TaskProfileId;
  alwaysSkillNames?: Set<string>;
}): {
  skills: Skill[];
  report: DynamicSkillPruningReport;
} {
  const promptText = params.promptText?.trim() ?? "";
  if (!promptText || params.skills.length === 0) {
    return { skills: params.skills, report: buildEmptyDynamicSkillPruningReport() };
  }

  const alwaysSkillNames = params.alwaysSkillNames ?? new Set<string>();
  const prunedEntries: DynamicSkillPruningReport["entries"] = [];
  let filtered = params.skills;

  const applyRule = (matcher: (skill: Skill) => boolean, reason: string) => {
    const next: Skill[] = [];
    for (const skill of filtered) {
      if (alwaysSkillNames.has(skill.name)) {
        next.push(skill);
        continue;
      }
      if (!matcher(skill)) {
        next.push(skill);
        continue;
      }
      prunedEntries.push({
        name: skill.name,
        reason,
        blockChars: measureSkillBlockChars(skill),
      });
    }
    if (next.length > 0) {
      filtered = next;
    }
  };

  if (!WEATHER_SIGNAL_PATTERN.test(promptText)) {
    applyRule(
      (skill) => /\bweather\b/i.test(buildSkillSearchText(skill)),
      "no weather signal in prompt",
    );
  }
  if (params.taskProfile !== "ops" && !OPS_SIGNAL_PATTERN.test(promptText)) {
    applyRule(
      (skill) =>
        /\bhealthcheck\b/i.test(buildSkillSearchText(skill)) ||
        /\bnode[-_ ]?connect\b/i.test(buildSkillSearchText(skill)) ||
        /\bgateway|cron|ops\b/i.test(buildSkillSearchText(skill)),
      "no runtime ops signal in prompt",
    );
  }
  if (!SKILL_AUTHORING_SIGNAL_PATTERN.test(promptText)) {
    applyRule(
      (skill) => /\bskill[-_ ]?creator\b/i.test(buildSkillSearchText(skill)),
      "no skill-authoring signal in prompt",
    );
  }

  return {
    skills: filtered,
    report: {
      prunedCount: prunedEntries.length,
      prunedBlockChars: prunedEntries.reduce((sum, entry) => sum + entry.blockChars, 0),
      entries: prunedEntries,
    },
  };
}
