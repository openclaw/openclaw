import { readLocalFileSafely } from "../infra/fs-safe.js";
import { readCodeModeSkill, type CodeModeSkill } from "./code-mode-skills.js";
import { buildLexicalIndex, scoreLexical, tokenizeDocument } from "./tool-search-ranking.js";
import { ToolInputError } from "./tools/common.js";

export type InstalledSkill = CodeModeSkill;

const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 20;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_RESULT_CHARS = 16_000;
export const MAX_SKILL_INSTRUCTION_BYTES = 256 * 1024;

function buildIndex(skills: readonly InstalledSkill[]) {
  return buildLexicalIndex(
    skills.map((skill) => ({
      value: skill,
      terms: tokenizeDocument(`${skill.name} ${skill.description}`),
    })),
  );
}

const indexes = new WeakMap<readonly InstalledSkill[], ReturnType<typeof buildIndex>>();

/** Search only the prepared, eligible catalog. No filesystem or marketplace discovery. */
export function searchInstalledSkills(
  skills: readonly InstalledSkill[],
  query: string,
  limit = 5,
): { skills: Array<{ name: string; description: string; location: string }>; hasMore: boolean } {
  const needle = query.trim();
  if (!needle || needle.length > MAX_QUERY_CHARS) {
    throw new ToolInputError(`query must contain 1-${MAX_QUERY_CHARS} characters.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolInputError(`limit must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  let index = indexes.get(skills);
  if (!index) {
    index = buildIndex(skills);
    indexes.set(skills, index);
  }
  // Tool-intent expansions (web, cron, etc.) do not belong to skill matching.
  const terms = [...new Set(tokenizeDocument(needle))].map((term) => ({ term, weight: 1 }));
  const ranked = scoreLexical(index, terms);
  const exact = skills.find((skill) => skill.name.toLowerCase() === needle.toLowerCase());
  if (exact && !ranked.some(({ value }) => value === exact)) {
    ranked.push({ value: exact, score: 0, matchedLiteral: true });
  }
  ranked.sort(
    (a, b) =>
      Number(b.value === exact) - Number(a.value === exact) ||
      b.score - a.score ||
      (a.value.name < b.value.name ? -1 : a.value.name > b.value.name ? 1 : 0),
  );
  const results: Array<{ name: string; description: string; location: string }> = [];
  let chars = 0;
  for (const { value } of ranked.slice(0, limit)) {
    const result = {
      name: value.name,
      description: value.description.slice(0, MAX_DESCRIPTION_CHARS),
      location: value.location,
    };
    chars += JSON.stringify(result).length;
    if (chars > MAX_RESULT_CHARS) {
      break;
    }
    results.push(result);
  }
  return { skills: results, hasMore: ranked.length > results.length };
}

/** Instructions are delivered whole or rejected, never silently truncated. */
export async function readInstalledSkill(
  skills: readonly InstalledSkill[],
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new ToolInputError(`Unknown installed skill ${JSON.stringify(name)}.`);
  }
  const content =
    typeof skill.source.readContent !== "string" && !skill.reader
      ? (
          await readLocalFileSafely({
            filePath: skill.source.filePath,
            maxBytes: MAX_SKILL_INSTRUCTION_BYTES,
          })
        ).buffer.toString("utf8")
      : await readCodeModeSkill(skill, signal);
  signal?.throwIfAborted();
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_INSTRUCTION_BYTES) {
    throw new ToolInputError(
      `Skill ${JSON.stringify(name)} exceeds the ${MAX_SKILL_INSTRUCTION_BYTES}-byte instruction limit.`,
    );
  }
  return content;
}
