import type { Skill as CanonicalSkill, SourceInfo } from "@mariozechner/pi-coding-agent";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export type Skill = CanonicalSkill & {
  // Preserve legacy source reads while keeping the canonical upstream shape.
  source?: string;
};

export function createSyntheticSourceInfo(
  path: string,
  options: {
    source: string;
    scope?: SourceScope;
    origin?: SourceOrigin;
    baseDir?: string;
  },
): SourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? "temporary",
    origin: options.origin ?? "top-level",
    baseDir: options.baseDir,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Keep this formatter's XML layout byte-for-byte aligned with the upstream
 * Agent Skills formatter so we can avoid importing the full pi-coding-agent
 * package root on the cold skills path. Visibility policy is applied upstream
 * before calling this helper.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillsProgressiveIndex(
  skills: Skill[],
  mode: "compact" | "view" | "search",
): string {
  if (skills.length === 0) {
    return "";
  }
  const accessGuidance =
    mode === "compact"
      ? "Use the read tool to load a listed skill's file from its location when the skill clearly applies."
      : "Before using a listed skill, prefer skill_view when available; fall back to read on the skill location.";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "This is a compact skill index; do not load a skill unless it clearly applies.",
    accessGuidance,
    ...(mode === "search"
      ? [
          "Use skill_search when you need a relevant skill that is not listed or you are unsure which skill matches.",
        ]
      : []),
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
