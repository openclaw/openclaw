import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { openLocalFileSafely, readLocalFileSafely } from "../infra/fs-safe.js";
import { readCodeModeSkill, type CodeModeSkill } from "./code-mode-skills.js";
import { getTextLexicalIndex } from "./tool-search-index.js";
import { scoreLexical, tokenizeDocument } from "./tool-search-ranking.js";
import { ToolInputError } from "./tools/common.js";

export type InstalledSkill = CodeModeSkill & {
  /** Prompt-listed instructions retain the shipped Code Mode whole-read contract. */
  promptListed?: boolean;
  assertCurrent?: () => void;
  /** The owner must bound I/O before allocating the returned content. */
  readSearchContent?: (maxBytes: number, signal?: AbortSignal) => Promise<string>;
};

const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 20;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_RESULT_CHARS = 16_000;
export const MAX_SKILL_INSTRUCTION_BYTES = 256 * 1024;
const MAX_BODY_SKILLS = 1_024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INDEX_BODY_BYTES = 4 * 1024 * 1024;
const READ_CONCURRENCY = 4;

function assertCatalogCurrent(skills: readonly InstalledSkill[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  for (const skill of skills) {
    skill.assertCurrent?.();
  }
}

function assertBodyReadable(canReadInstructions: () => boolean) {
  if (!canReadInstructions()) {
    throw new ToolInputError("Skill instruction-read permission changed during search.");
  }
}

async function prepareBodyView(
  skills: readonly InstalledSkill[],
  canReadInstructions: () => boolean,
  signal?: AbortSignal,
) {
  const selected = skills
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_BODY_SKILLS);
  const bodyBytes = Math.min(
    MAX_BODY_BYTES,
    Math.floor(MAX_INDEX_BODY_BYTES / Math.max(1, selected.length)),
  );
  const documents: Array<{ value: InstalledSkill; content: string }> = [];
  let truncatedBodies = 0;
  for (let offset = 0; offset < selected.length; offset += READ_CONCURRENCY) {
    const batch = await Promise.allSettled(
      selected.slice(offset, offset + READ_CONCURRENCY).map(async (skill) => {
        signal?.throwIfAborted();
        skill.assertCurrent?.();
        assertBodyReadable(canReadInstructions);
        try {
          const body = await readSearchBody(skill, bodyBytes, signal);
          truncatedBodies += body?.truncated ? 1 : 0;
          return body && { value: skill, content: body.content };
        } catch {
          // Unreadable bodies retain metadata.
          return undefined;
        } finally {
          // Revocation and cancellation must not become partial search coverage.
          signal?.throwIfAborted();
          skill.assertCurrent?.();
          assertBodyReadable(canReadInstructions);
        }
      }),
    );
    // Join all owned reads before surfacing cancellation or authority loss.
    for (const result of batch) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      if (result.value) {
        documents.push(result.value);
      }
    }
  }
  assertCatalogCurrent(skills, signal);
  assertBodyReadable(canReadInstructions);
  return {
    bodies: getTextLexicalIndex(documents.map(({ content }) => content)),
    skills: documents.map(({ value }) => value),
    coverage: {
      bodyIndexed: documents.length,
      metadataOnly: skills.length - documents.length,
      truncatedBodies,
    },
  };
}

async function readSearchBody(skill: InstalledSkill, maxBytes: number, signal?: AbortSignal) {
  const inline = skill.source.readContent;
  if (typeof inline === "string") {
    const prefix = inline.slice(0, maxBytes);
    const bytes = Buffer.from(prefix);
    return {
      content: bytes.subarray(0, maxBytes).toString("utf8"),
      truncated: prefix.length < inline.length || bytes.length > maxBytes,
    };
  }
  if (skill.readSearchContent) {
    const content = await skill.readSearchContent(maxBytes, signal);
    if (Buffer.byteLength(content) > maxBytes) {
      throw new Error("Skill search reader exceeded its byte budget.");
    }
    return { content, truncated: false };
  }
  // An opaque reader is not permission to read an ambient host path, nor a
  // guarantee that a whole-resource read is bounded enough for catalog search.
  if (skill.reader) {
    return undefined;
  }
  const opened = await openLocalFileSafely({ filePath: skill.source.filePath });
  try {
    // One extra byte detects truncation without reading the rest of the file.
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await opened.handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return {
      content: buffer.subarray(0, Math.min(total, maxBytes)).toString("utf8"),
      truncated: total > maxBytes,
    };
  } finally {
    await opened.handle.close();
  }
}

const bodyViews = new WeakMap<
  readonly InstalledSkill[],
  Promise<Awaited<ReturnType<typeof prepareBodyView>> | void>
>();

/** Search only the prepared, eligible catalog. No filesystem or marketplace discovery. */
export async function searchInstalledSkills(
  skills: readonly InstalledSkill[],
  query: string,
  limit = 5,
  signal?: AbortSignal,
  canReadInstructions: () => boolean = () => false,
): Promise<{
  skills: Array<{ name: string; description: string; location: string }>;
  hasMore: boolean;
  coverage?: { bodyIndexed: number; metadataOnly: number; truncatedBodies: number };
}> {
  const needle = query.trim();
  if (!needle || needle.length > MAX_QUERY_CHARS) {
    throw new ToolInputError(`query must contain 1-${MAX_QUERY_CHARS} characters.`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ToolInputError(`limit must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  assertCatalogCurrent(skills, signal);
  const includeBodies = canReadInstructions();
  let index: Awaited<ReturnType<typeof prepareBodyView>> | void = undefined;
  if (includeBodies) {
    while (!index) {
      const pending = bodyViews.get(skills);
      if (pending) {
        index = await racePromiseWithAbortSignal(pending, signal);
      } else {
        // Reads belong to this run; only positional postings are shared by content.
        // Waiters can cancel independently or retry after failed reads have joined.
        const build = prepareBodyView(skills, canReadInstructions, signal);
        bodyViews.set(
          skills,
          build.catch(() => {
            bodyViews.delete(skills);
          }),
        );
        index = await build;
      }
      assertCatalogCurrent(skills, signal);
      assertBodyReadable(canReadInstructions);
    }
  }
  // Tool-intent expansions (web, cron, etc.) do not belong to skill matching.
  const terms = [...new Set(tokenizeDocument(needle))].map((term) => ({ term, weight: 1 }));
  const scores = new Map<InstalledSkill, number>();
  for (const { value, score } of scoreLexical(
    getTextLexicalIndex(skills.map((skill) => `${skill.name} ${skill.description}`)),
    terms,
  )) {
    scores.set(skills[value]!, score * 2);
  }
  if (includeBodies && index) {
    assertBodyReadable(canReadInstructions);
    for (const { value, score } of scoreLexical(index.bodies, terms)) {
      const skill = index.skills[value]!;
      scores.set(skill, (scores.get(skill) ?? 0) + score);
    }
  }
  const ranked = [...scores].map(([value, score]) => ({ value, score }));
  const exact =
    skills.find((skill) => skill.name === needle) ??
    skills.find((skill) => skill.name.toLowerCase() === needle.toLowerCase());
  if (exact && !ranked.some(({ value }) => value === exact)) {
    ranked.push({ value: exact, score: 0 });
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
  assertCatalogCurrent(skills, signal);
  if (includeBodies) {
    assertBodyReadable(canReadInstructions);
  }
  const coverage =
    includeBodies && index
      ? index.coverage
      : { bodyIndexed: 0, metadataOnly: skills.length, truncatedBodies: 0 };
  return {
    skills: results,
    hasMore: ranked.length > results.length,
    ...(coverage.metadataOnly || coverage.truncatedBodies ? { coverage } : {}),
  };
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
  skill.assertCurrent?.();
  const content =
    !skill.promptListed && typeof skill.source.readContent !== "string" && !skill.reader
      ? (
          await readLocalFileSafely({
            filePath: skill.source.filePath,
            maxBytes: MAX_SKILL_INSTRUCTION_BYTES,
          })
        ).buffer.toString("utf8")
      : await readCodeModeSkill(skill, signal);
  signal?.throwIfAborted();
  skill.assertCurrent?.();
  if (!skill.promptListed && Buffer.byteLength(content, "utf8") > MAX_SKILL_INSTRUCTION_BYTES) {
    throw new ToolInputError(
      `Skill ${JSON.stringify(name)} exceeds the ${MAX_SKILL_INSTRUCTION_BYTES}-byte instruction limit.`,
    );
  }
  return content;
}
