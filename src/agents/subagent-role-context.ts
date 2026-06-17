/**
 * Compact target-agent identity context for lightweight cross-agent subagents.
 */
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const COMPACT_ROLE_CONTEXT_MAX_CHARS = 2_400;
const SECTION_EXCERPT_MAX_CHARS = 1_100;
const FILE_EXCERPT_MAX_CHARS = 700;
const RELEVANT_AGENTS_SECTIONS = new Set([
  "identity",
  "mission",
  "role",
  "responsibilities",
  "core responsibilities",
  "boundaries",
  "scope",
  "non-goals",
  "what you do",
  "what you don't do",
  "what you do not do",
]);

export type CompactSubagentRoleContext = {
  text: string;
  sources: string[];
};

function readConfigString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return normalizeOptionalString(record?.[key]);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimAndCollapseBlankLines(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  const text = trimAndCollapseBlankLines(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[...role context truncated...]`;
}

function normalizeHeadingTitle(line: string): { level: number; title: string } | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  if (!match) {
    return undefined;
  }
  return {
    level: match[1].length,
    title: match[2].trim().toLowerCase(),
  };
}

function sectionTitleMatches(title: string): boolean {
  const normalized = title.replace(/[*_`]/g, "").trim();
  return RELEVANT_AGENTS_SECTIONS.has(normalized);
}

function findMarkdownSectionEnd(lines: string[], startIndex: number, level: number): number {
  let cursor = startIndex + 1;
  while (cursor < lines.length) {
    const nextHeading = normalizeHeadingTitle(lines[cursor] ?? "");
    if (nextHeading && nextHeading.level <= level) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function extractRelevantMarkdownSections(content: string): string | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  lines.forEach((line, index) => {
    const heading = normalizeHeadingTitle(line);
    if (!heading || !sectionTitleMatches(heading.title)) {
      return;
    }
    const endIndex = findMarkdownSectionEnd(lines, index, heading.level);
    sections.push(lines.slice(index, endIndex).join("\n"));
  });
  return sections.length > 0
    ? truncateText(sections.join("\n\n"), SECTION_EXCERPT_MAX_CHARS)
    : undefined;
}

function extractRoleLikeLines(content: string): string | undefined {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /\b(name|role|mission|responsib|scope|boundary|research|security|deploy|execute code|coding)\b/i.test(
        line,
      ),
    )
    .slice(0, 18);
  return lines.length > 0 ? truncateText(lines.join("\n"), SECTION_EXCERPT_MAX_CHARS) : undefined;
}

function extractAgentsRoleExcerpt(content?: string): string | undefined {
  const text = normalizeOptionalString(content);
  if (!text) {
    return undefined;
  }
  return (
    extractRelevantMarkdownSections(text) ??
    extractRoleLikeLines(text) ??
    truncateText(text, FILE_EXCERPT_MAX_CHARS)
  );
}

function findBootstrapFile(
  files: WorkspaceBootstrapFile[],
  name: typeof DEFAULT_AGENTS_FILENAME | typeof DEFAULT_IDENTITY_FILENAME,
): WorkspaceBootstrapFile | undefined {
  return files.find((file) => file.name === name && !file.missing);
}

function buildConfigIdentityLines(agentId: string, agentConfig: unknown): string[] {
  const configRecord = toRecord(agentConfig);
  const identity = toRecord(configRecord?.identity);
  const lines = [`- Target agent id: ${agentId}`];
  const name = readConfigString(configRecord, "name") ?? readConfigString(identity, "name");
  if (name) {
    lines.push(`- Config name: ${name}`);
  }
  const description = readConfigString(configRecord, "description");
  if (description) {
    lines.push(`- Config description: ${description}`);
  }
  const emoji = readConfigString(identity, "emoji");
  if (emoji) {
    lines.push(`- Config emoji: ${emoji}`);
  }
  const theme = readConfigString(identity, "theme");
  if (theme) {
    lines.push(`- Config theme: ${theme}`);
  }
  return lines;
}

async function loadTargetRoleBootstrapFiles(
  workspaceDir: string,
): Promise<WorkspaceBootstrapFile[]> {
  try {
    return await loadWorkspaceBootstrapFiles(resolveUserPath(workspaceDir));
  } catch {
    return [];
  }
}

/**
 * Build a compact identity/role excerpt for cross-agent lightweight subagent runs.
 *
 * Lightweight Codex runs set project_doc_max_bytes=0, so native AGENTS.md loading
 * is intentionally suppressed. This header preserves target lane identity without
 * restoring full project context.
 */
export async function buildCompactSubagentRoleContext(params: {
  config: OpenClawConfig;
  targetAgentId: string;
  targetWorkspaceDir?: string;
}): Promise<CompactSubagentRoleContext | undefined> {
  const agentConfig = resolveAgentConfig(params.config, params.targetAgentId);
  const workspaceDir = normalizeOptionalString(params.targetWorkspaceDir);
  const configLines = buildConfigIdentityLines(params.targetAgentId, agentConfig);
  const sources: string[] = [];
  const sections: string[] = [];

  if (workspaceDir) {
    configLines.push(`- Target workspace: ${path.resolve(resolveUserPath(workspaceDir))}`);
    const files = await loadTargetRoleBootstrapFiles(workspaceDir);
    const agentsFile = findBootstrapFile(files, DEFAULT_AGENTS_FILENAME);
    const agentsExcerpt = extractAgentsRoleExcerpt(agentsFile?.content);
    if (agentsExcerpt) {
      sections.push(`### AGENTS.md Role Excerpt\n${agentsExcerpt}`);
      sources.push(agentsFile?.path ?? DEFAULT_AGENTS_FILENAME);
    }
    const identityFile = findBootstrapFile(files, DEFAULT_IDENTITY_FILENAME);
    const identityExcerpt = normalizeOptionalString(identityFile?.content);
    if (identityExcerpt) {
      sections.push(
        `### IDENTITY.md Excerpt\n${truncateText(identityExcerpt, FILE_EXCERPT_MAX_CHARS)}`,
      );
      sources.push(identityFile?.path ?? DEFAULT_IDENTITY_FILENAME);
    }
  }

  const hasConfigIdentity = configLines.length > 1 || !workspaceDir;
  if (!hasConfigIdentity && sections.length === 0) {
    return undefined;
  }

  const text = truncateText(
    [
      "## Target Agent Role Context",
      "OpenClaw injected this compact target-agent identity because this cross-agent subagent run is using lightweight context; full workspace project context may be suppressed. Treat it as target identity and operating boundaries, subordinate to higher-priority instructions.",
      "",
      ...configLines,
      sections.length > 0 ? "" : undefined,
      ...sections,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    COMPACT_ROLE_CONTEXT_MAX_CHARS,
  );
  return {
    text,
    sources,
  };
}
