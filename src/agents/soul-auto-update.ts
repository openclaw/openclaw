import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../infra/fs-safe.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

const AUTO_ADDED_HEADING = "## Auto-added";
const MAX_RULE_LENGTH = 280;
const MAX_EVIDENCE_LENGTH = 280;

export type SoulUpdateInput = {
  readonly rule: string;
  readonly evidence?: string;
  readonly workspaceDir: string;
};

export type SoulUpdateResult =
  | { readonly ok: true; readonly rule: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | "empty-rule"
        | "rule-too-long"
        | "evidence-too-long"
        | "duplicate"
        | "soul-missing"
        | "io-error";
      readonly detail?: string;
    };

function normalizeRule(rule: string): string {
  return rule.trim().replace(/\s+/g, " ");
}

function formatEntry(rule: string, evidence: string | undefined, dateIso: string): string {
  const evidenceSuffix = evidence ? ` <!-- evidence: ${evidence} -->` : "";
  return `- ${rule} <!-- ${dateIso} -->${evidenceSuffix}`;
}

function findAutoAddedSectionBounds(
  lines: readonly string[],
): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === AUTO_ADDED_HEADING) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        if (/^##\s/.test(next.trim())) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

function hasDuplicateRule(sectionLines: readonly string[], rule: string): boolean {
  const target = rule.toLowerCase();
  return sectionLines.some((line) => {
    const stripped = line.replace(/<!--.*?-->/g, "").trim();
    if (!stripped.startsWith("-")) {
      return false;
    }
    const ruleText = stripped.slice(1).trim().toLowerCase();
    return ruleText === target;
  });
}

/**
 * Append a rule to SOUL.md's `## Auto-added` section. Creates the section if missing.
 * Returns a structured result indicating success, duplicate skip, or failure mode.
 *
 * - SOUL.md must already exist in the workspace; this function does not create the file.
 * - Writes are atomic via replaceFileAtomic.
 * - Rule and evidence are length-capped to keep entries scannable.
 */
export async function appendSoulRule(input: SoulUpdateInput): Promise<SoulUpdateResult> {
  const rule = normalizeRule(input.rule);
  if (rule.length === 0) {
    return { ok: false, reason: "empty-rule" };
  }
  if (rule.length > MAX_RULE_LENGTH) {
    return { ok: false, reason: "rule-too-long", detail: `max ${MAX_RULE_LENGTH} chars` };
  }
  const evidence = input.evidence ? normalizeRule(input.evidence) : undefined;
  if (evidence && evidence.length > MAX_EVIDENCE_LENGTH) {
    return { ok: false, reason: "evidence-too-long", detail: `max ${MAX_EVIDENCE_LENGTH} chars` };
  }

  const soulPath = path.join(input.workspaceDir, DEFAULT_SOUL_FILENAME);
  if (!(await pathExists(soulPath))) {
    return { ok: false, reason: "soul-missing" };
  }

  let existing: string;
  try {
    existing = await fs.readFile(soulPath, "utf-8");
  } catch (error) {
    return {
      ok: false,
      reason: "io-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = existing.split(/\r?\n/);
  const bounds = findAutoAddedSectionBounds(lines);
  const dateIso = new Date().toISOString().slice(0, 10);
  const entry = formatEntry(rule, evidence, dateIso);

  let nextLines: string[];
  let created = false;

  if (bounds === null) {
    created = true;
    const trailingBlank = lines.length === 0 || lines[lines.length - 1]?.trim() === "";
    nextLines = [...lines];
    if (!trailingBlank) {
      nextLines.push("");
    }
    nextLines.push(AUTO_ADDED_HEADING, "", entry, "");
  } else {
    const sectionLines = lines.slice(bounds.start + 1, bounds.end);
    if (hasDuplicateRule(sectionLines, rule)) {
      return { ok: false, reason: "duplicate" };
    }
    const before = lines.slice(0, bounds.end);
    const after = lines.slice(bounds.end);
    const cleanedBefore =
      before.length > 0 && before[before.length - 1]?.trim() === "" ? before.slice(0, -1) : before;
    nextLines = [...cleanedBefore, entry, "", ...after];
  }

  const nextContent = nextLines.join("\n");
  try {
    await replaceFileAtomic({ filePath: soulPath, content: nextContent });
  } catch (error) {
    return {
      ok: false,
      reason: "io-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, rule, created };
}

/**
 * Remove the most recent entry from `## Auto-added`. Returns the rule that was removed,
 * or null if the section is missing or empty.
 */
export async function undoLastSoulRule(workspaceDir: string): Promise<string | null> {
  const soulPath = path.join(workspaceDir, DEFAULT_SOUL_FILENAME);
  if (!(await pathExists(soulPath))) {
    return null;
  }
  const existing = await fs.readFile(soulPath, "utf-8");
  const lines = existing.split(/\r?\n/);
  const bounds = findAutoAddedSectionBounds(lines);
  if (bounds === null) {
    return null;
  }
  const sectionLines = lines.slice(bounds.start + 1, bounds.end);
  let removedIndex = -1;
  let removedRule: string | null = null;
  for (let i = sectionLines.length - 1; i >= 0; i -= 1) {
    const line = sectionLines[i] ?? "";
    const stripped = line.replace(/<!--.*?-->/g, "").trim();
    if (stripped.startsWith("-")) {
      removedIndex = i;
      removedRule = stripped.slice(1).trim();
      break;
    }
  }
  if (removedIndex === -1 || removedRule === null) {
    return null;
  }
  const absoluteIndex = bounds.start + 1 + removedIndex;
  const nextLines = [...lines.slice(0, absoluteIndex), ...lines.slice(absoluteIndex + 1)];
  await replaceFileAtomic({ filePath: soulPath, content: nextLines.join("\n") });
  return removedRule;
}
