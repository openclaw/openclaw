// Advisory SKILL.md feedback for skill_workshop writes; never blocks a write.
import { splitSkillFrontmatter } from "openclaw/plugin-sdk/skill-authoring-runtime";

const MAX_DESCRIPTION_BYTES = 160;
const MAX_BODY_LINES = 250;
/** Body size past which a skill gets the sprawl advisory and becomes eligible for a diet. */
export const MAX_BODY_BYTES = 12_000;
const MIN_NEGATION_LINES = 3;
const MAX_ADVISORIES = 3;
/** A whole-file SKILL.md replacement keeping fewer body lines than this share gets an advisory. */
const SHRINK_ADVISORY_RATIO = 0.6;
const MAX_LISTED_SECTIONS = 8;

const NO_OP_WORDS =
  /\b(?:powerful|comprehensive|robust|seamless(?:ly)?|cutting-edge|state-of-the-art|be thorough|make sure to)\b/gi;
const SHOUTING = /\bIMPORTANT\b/g;
const NEGATION_LINE = /^(?:[-*+]|\d+[.)])?\s*(?:\*\*)?(?:never|don['’]t|do not)\b/i;
const NARRATIVE_LINE = /^(?:[-*+]\s*)?(?:\*\*)?(?:UPDATE|NOTE|EDIT)\b|\b20\d\d-\d\d-\d\d\b/;
const CHANGE_NOTE_TITLE = /^#\s+(?:fix|proposal|changes?|changelog)\b/i;
const SECTION_HEADING = /^##\s+(\S.*)$/;

const withoutCodeBlocks = (body: string) => body.replace(/```[\s\S]*?```/g, "");

/** Authoring-convention findings for one SKILL.md, most useful first. */
function lintSkillMarkdown(content: string): { rule: string; message: string }[] {
  const { frontmatter, body } = splitSkillFrontmatter(content);
  const description = (frontmatter.description ?? "").trim();
  // Code is quoted material; only prose carries authoring style.
  const prose = withoutCodeBlocks(body)
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .map((line) => line.trim());
  const descriptionBytes = Buffer.byteLength(description);
  const bodyLines = body.split("\n").length;
  const bodyBytes = Buffer.byteLength(body);
  const styled = [description, ...prose].join("\n");
  const noOps = [
    ...new Set([...(styled.match(NO_OP_WORDS) ?? []), ...(styled.match(SHOUTING) ?? [])]),
  ];
  const negations = prose.filter((line) => NEGATION_LINE.test(line)).length;
  const title = prose.find((line) => line.startsWith("# "));
  const checks: Array<[rule: string, message: string | false]> = [
    [
      "change-note",
      title !== undefined &&
        CHANGE_NOTE_TITLE.test(title) &&
        `title "${title}" reads as a change note; SKILL.md holds the whole procedure, not what changed.`,
    ],
    [
      "description-length",
      descriptionBytes > MAX_DESCRIPTION_BYTES &&
        `description is ${descriptionBytes} bytes; trim it to ≤${MAX_DESCRIPTION_BYTES} with the trigger first.`,
    ],
    [
      "description-identity",
      /^(?:this|a|the) skill\b/i.test(description) &&
        'description opens with "This skill"; open with the situation that triggers it.',
    ],
    [
      "sprawl",
      (bodyLines > MAX_BODY_LINES || bodyBytes > MAX_BODY_BYTES) &&
        `SKILL.md body is ${bodyLines} lines (${bodyBytes} bytes); move reference only some runs need into references/ and point to it from its step.`,
    ],
    [
      "no-op",
      noOps.length > 0 &&
        `cut no-op emphasis (${noOps.slice(0, 3).join(", ")}); plain steps carry the same weight.`,
    ],
    [
      "negation",
      negations >= MIN_NEGATION_LINES &&
        `${negations} lines start with Never/Don't; state the behavior to produce instead.`,
    ],
    [
      "narrative",
      prose.some((line) => NARRATIVE_LINE.test(line)) &&
        "found an update note or date; fold the lesson into the step it changes.",
    ],
  ];
  return checks.flatMap(([rule, message]) => (message ? [{ rule, message }] : []));
}

/** Advisory lines for a successful SKILL.md write: lint rules this write introduced. */
export function skillWriteAdvisories(before: string, after: string): string[] {
  const standing = new Set(lintSkillMarkdown(before).map((finding) => finding.rule));
  return lintSkillMarkdown(after)
    .filter((finding) => !standing.has(finding.rule))
    .slice(0, MAX_ADVISORIES)
    .map((finding) => `Advisory (not blocking): ${finding.message} Fix with action=patch.`);
}

function trimmedLines(body: string): string[] {
  const trimmed = body.trim();
  return trimmed ? trimmed.split("\n") : [];
}

function sectionHeadings(body: string): string[] {
  return trimmedLines(withoutCodeBlocks(body)).flatMap((line) => {
    const heading = SECTION_HEADING.exec(line.trimEnd())?.[1];
    return heading ? [heading] : [];
  });
}

/**
 * Size and section impact of replacing a live SKILL.md. Whole-file writes replace and never
 * merge, so a change note sent as the content silently drops the procedure it meant to amend.
 * Empty when there is no live SKILL.md to compare against.
 */
export function skillReplacementReport(before: string, after: string): string[] {
  if (!before.trim()) {
    return [];
  }
  const previous = splitSkillFrontmatter(before).body;
  const next = splitSkillFrontmatter(after).body;
  const fromLines = trimmedLines(previous).length;
  const toLines = trimmedLines(next).length;
  const change = fromLines === 0 ? 0 : Math.round(((toLines - fromLines) / fromLines) * 100);
  const lines = [
    `SKILL.md body: ${fromLines} → ${toLines} lines (${change >= 0 ? "+" : ""}${change}%).`,
  ];
  const kept = new Set(sectionHeadings(next));
  const removed = [...new Set(sectionHeadings(previous).filter((heading) => !kept.has(heading)))];
  if (removed.length > 0) {
    const listed = removed.slice(0, MAX_LISTED_SECTIONS).map((heading) => `"## ${heading}"`);
    const more = removed.length - listed.length;
    lines.push(`Removed sections: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`);
  }
  if (toLines < fromLines * SHRINK_ADVISORY_RATIO) {
    lines.push(
      `Advisory (not blocking): the new SKILL.md body is ${Math.round((toLines / fromLines) * 100)}% of the previous length. Content replaces the whole file and is not merged; if it was meant as a change note, keep the full procedure and make the change with action=patch.`,
    );
  }
  return lines;
}
