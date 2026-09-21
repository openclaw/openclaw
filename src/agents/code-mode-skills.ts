import { readFile } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Skill } from "../skills/loading/skill-contract.js";
import { ToolInputError } from "./tool-input-error.js";
import {
  buildLexicalIndex,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";

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

/** Adapt policy-selected, runtime-mapped sources without using prompt text as authority. */
export function resolveCodeModeSkills(params: {
  candidates: readonly Skill[];
  reader?: CodeModeSkillReader;
}): CodeModeSkill[] {
  return params.candidates
    .filter((skill) => !skill.disableModelInvocation)
    .map((source) => ({
      name: source.name,
      description: [source.description, source.locationNote].filter(Boolean).join("\n"),
      location: source.filePath,
      source: { filePath: source.filePath, readContent: source.readContent },
      reader: params.reader,
    }));
}

const indexes = new WeakMap<
  readonly CodeModeSkill[],
  ReturnType<typeof buildLexicalIndex<CodeModeSkill>>
>();

/** Search only the prepared catalog. A miss is not evidence that no procedure could help. */
export function searchCodeModeSkills(
  skills: readonly CodeModeSkill[],
  query: unknown,
  options?: unknown,
) {
  if (typeof query !== "string" || query.length > 4096) {
    throw new ToolInputError("skills.search query must be a string of at most 4096 characters.");
  }
  if (options !== undefined && !isRecord(options)) {
    throw new ToolInputError("skills.search options must be an object.");
  }
  const limit = isRecord(options) ? (options.limit ?? 5) : 5;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolInputError("skills.search limit must be an integer between 1 and 20.");
  }
  const exact = query.trim().toLowerCase();
  const exactMatches = skills.filter((skill) => skill.name.toLowerCase() === exact);
  let index = indexes.get(skills);
  if (!index) {
    index = buildLexicalIndex(
      skills.map((skill) => ({
        value: skill,
        terms: tokenizeDocument(skill.name + " " + skill.description),
      })),
    );
    indexes.set(skills, index);
  }
  const matches = scoreLexical(index, tokenizeQuery(query))
    .filter(({ value }) => !exactMatches.includes(value))
    .toSorted(
      (a, b) =>
        Number(b.matchedLiteral) - Number(a.matchedLiteral) ||
        b.score - a.score ||
        a.value.name.localeCompare(b.value.name, "en"),
    );
  return [...exactMatches, ...matches.map(({ value }) => value)]
    .slice(0, limit)
    .map(({ name, description, location }) => ({
      name,
      description: truncateUtf16Safe(description, 500),
      location,
    }));
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
