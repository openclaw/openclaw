/**
 * Persona expansion engine.
 *
 * Expands a persona template (.md with YAML frontmatter) into:
 * - A unified AGENT.md file (frontmatter + body)
 * - Workspace bootstrap files (SOUL.md, IDENTITY.md, HEARTBEAT.md, USER.md)
 *
 * TOOLS.md and BOOTSTRAP.md are copied from system templates (not persona-driven).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PersonaFrontmatterSchema, type PersonaFrontmatter } from "../config/zod-schema.persona.js";
import { resolveWorkspaceTemplateDir } from "./workspace-templates.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Parsed persona with validated frontmatter and extracted body sections. */
export interface ParsedPersona {
  frontmatter: PersonaFrontmatter;
  body: string;
  sections: Map<string, string>;
}

/** Generated workspace file ready to write. */
export interface GeneratedFile {
  name: string;
  content: string;
}

/** Full expansion result — agent file + workspace files. */
export interface ExpansionResult {
  agentMd: string;
  workspaceFiles: GeneratedFile[];
}

/** Options for expanding a persona. */
export interface ExpandOptions {
  agentName: string;
  agentId: string;
  /** Override frontmatter fields (model, tools, etc.) */
  overrides?: Record<string, unknown>;
}

// ── 3.1: Persona Parser ─────────────────────────────────────────────────────

const FRONTMATTER_SPLIT_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const SECTION_HEADING_RE = /^## (.+)$/gm;

/**
 * Parse a persona .md file: split frontmatter, validate, extract sections.
 */
export function parsePersona(content: string): ParsedPersona | { error: string } {
  const match = FRONTMATTER_SPLIT_RE.exec(content);
  if (!match) {
    return { error: "Persona file missing valid frontmatter (--- delimiters)" };
  }

  const [, yamlBlock, body] = match;
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(yamlBlock);
  } catch (err) {
    return { error: `Invalid YAML in persona frontmatter: ${(err as Error).message}` };
  }

  const result = PersonaFrontmatterSchema.safeParse(rawFrontmatter);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: `Persona frontmatter validation failed: ${issues.join(", ")}` };
  }

  const sections = extractSections(body);
  return { frontmatter: result.data, body: body.trimStart(), sections };
}

/**
 * Extract named ## sections from markdown body into a map.
 */
function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headings: Array<{ name: string; start: number }> = [];

  let m: RegExpExecArray | null;
  // Reset lastIndex for global regex
  SECTION_HEADING_RE.lastIndex = 0;
  while ((m = SECTION_HEADING_RE.exec(body)) !== null) {
    headings.push({ name: m[1], start: m.index + m[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const end =
      i + 1 < headings.length
        ? headings[i + 1].start - `## ${headings[i + 1].name}`.length
        : body.length;
    const content = body.slice(heading.start, end).trim();
    sections.set(heading.name, content);
  }

  return sections;
}

// ── 3.5: Template Variables ─────────────────────────────────────────────────

/**
 * Replace template variables in content.
 */
function applyTemplateVariables(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ── 3.2: Section-to-File Mapper ─────────────────────────────────────────────

/**
 * Generate IDENTITY.md from persona Identity section + frontmatter.
 */
function generateIdentityMd(persona: ParsedPersona, agentName: string): string {
  const fm = persona.frontmatter;
  const identitySection = persona.sections.get("Identity") ?? "";

  // If there's a rich Identity section, use it directly
  if (identitySection.trim()) {
    return `# IDENTITY.md — ${agentName}

${identitySection}

---

${agentName} operates with the ${fm.slug} persona.
`;
  }

  // Fallback: generate from frontmatter
  return `# IDENTITY.md — ${agentName}

- **Name:** ${agentName}
- **Role:** ${fm.role}
- **Department:** ${fm.department}
- **Vibe:** ${fm.vibe ?? "Professional and focused."}
- **Emoji:** ${fm.emoji}

---

${agentName} operates with the ${fm.slug} persona.
`;
}

/**
 * Generate SOUL.md from Core Mission + Critical Rules + Communication Style.
 */
function generateSoulMd(persona: ParsedPersona, agentName: string): string {
  const coreMission = persona.sections.get("Core Mission") ?? "";
  const criticalRules = persona.sections.get("Critical Rules") ?? "";
  const commStyle = persona.sections.get("Communication Style") ?? "";

  const parts = [`# SOUL.md — ${agentName}`, ""];

  if (coreMission) {
    parts.push("## Core Mission", "", coreMission, "");
  }
  if (criticalRules) {
    parts.push("## Critical Rules", "", criticalRules, "");
  }
  if (commStyle) {
    parts.push("## Communication Style", "", commStyle, "");
  }

  parts.push("---", "", "_Generated from persona: " + persona.frontmatter.slug + "_", "");
  return parts.join("\n");
}

/**
 * Generate HEARTBEAT.md from Heartbeat Guidance section.
 * Returns null if no heartbeat section exists (skip file).
 */
function generateHeartbeatMd(persona: ParsedPersona, agentName: string): string | null {
  const heartbeat = persona.sections.get("Heartbeat Guidance");
  if (!heartbeat?.trim()) {
    return null;
  }

  return `# HEARTBEAT.md — ${agentName}

${heartbeat}

---

_Generated from persona: ${persona.frontmatter.slug}_
`;
}

/**
 * Generate USER.md from frontmatter metadata.
 */
function generateUserMd(persona: ParsedPersona, agentName: string): string {
  const fm = persona.frontmatter;
  const tags = fm.tags?.join(", ") ?? "";

  return `# About This Agent

- **Name:** ${agentName}
- **Persona:** ${fm.name}
- **Department:** ${fm.department}
- **Role:** ${fm.role}
- **Focus areas:** ${tags || fm.description}

This agent was created from the \`${fm.slug}\` persona template.
Customize this file to add user-specific context, preferences, or project details.
`;
}

// ── 3.3: Unified Agent File Generator ───────────────────────────────────────

/**
 * Generate the unified AGENT.md file (YAML frontmatter + markdown body).
 */
function generateAgentMd(persona: ParsedPersona, options: ExpandOptions): string {
  const fm = persona.frontmatter;

  // Build frontmatter object for the agent
  const agentFrontmatter: Record<string, unknown> = {
    id: options.agentId,
    name: options.agentName,
    persona: fm.slug,
    tier: fm.tier ?? 2,
    role: fm.role,
    department: fm.department,
    description: fm.description,
    version: fm.version ?? "1.0.0",
    identity: { emoji: fm.emoji },
  };

  // Map persona tools (flat list) to agent tools ({ allow: [...] })
  if (fm.tools && fm.tools.length > 0) {
    agentFrontmatter.tools = { allow: fm.tools };
  }

  if (fm.capabilities && fm.capabilities.length > 0) {
    agentFrontmatter.capabilities = fm.capabilities;
  }

  // Apply user overrides
  if (options.overrides) {
    Object.assign(agentFrontmatter, options.overrides);
  }

  // Serialize frontmatter as YAML
  const yamlLines: string[] = [];
  for (const [key, value] of Object.entries(agentFrontmatter)) {
    yamlLines.push(serializeYamlField(key, value, 0));
  }

  return `---
${yamlLines.join("\n")}
---

${persona.body}`;
}

/**
 * Simple YAML field serializer (handles strings, numbers, booleans, arrays, objects).
 */
function serializeYamlField(key: string, value: unknown, indent: number): string {
  const prefix = " ".repeat(indent);
  if (value === null || value === undefined) {
    return `${prefix}${key}:`;
  }
  if (typeof value === "string") {
    // Quote strings that could be misinterpreted
    if (
      value.includes(":") ||
      value.includes("#") ||
      value.includes("\n") ||
      value.startsWith('"')
    ) {
      return `${prefix}${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${prefix}${key}: ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${prefix}${key}: ${value}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${prefix}${key}: []`;
    }
    const items = value.map((item) => `${prefix}  - ${item}`).join("\n");
    return `${prefix}${key}:\n${items}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const nested = entries.map(([k, v]) => serializeYamlField(k, v, indent + 2)).join("\n");
    return `${prefix}${key}:\n${nested}`;
  }
  return `${prefix}${key}: ${JSON.stringify(value)}`;
}

// ── 3.4: Expansion Orchestrator ─────────────────────────────────────────────

const FRONTMATTER_STRIP_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;

/**
 * Load a system template file, stripping frontmatter.
 */
async function loadSystemTemplate(name: string): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  const content = await readFile(join(templateDir, name), "utf-8");
  return content.replace(FRONTMATTER_STRIP_RE, "").trimStart();
}

/**
 * Parse a persona file from disk by slug.
 */
export async function loadPersonaBySlug(
  personasDir: string,
  slug: string,
): Promise<ParsedPersona | { error: string }> {
  // Search all category directories for the slug
  const { readdir } = await import("node:fs/promises");
  const categories = await readdir(personasDir, { withFileTypes: true });

  for (const cat of categories.filter((e) => e.isDirectory())) {
    const filePath = join(personasDir, cat.name, `${slug}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      return parsePersona(content);
    } catch {
      // Not in this category, keep searching
    }
  }

  return { error: `Persona "${slug}" not found in any category under ${personasDir}` };
}

/**
 * Expand a persona into a full agent file + workspace bootstrap files.
 *
 * Atomic: returns all files or an error. Caller writes to disk.
 */
export async function expandPersona(
  personaContent: string | ParsedPersona,
  options: ExpandOptions,
): Promise<ExpansionResult | { error: string }> {
  // Parse if raw content
  const persona =
    typeof personaContent === "string" ? parsePersona(personaContent) : personaContent;

  if ("error" in persona) {
    return persona;
  }

  // Validate required sections
  const requiredSections = ["Identity", "Core Mission", "Critical Rules"];
  for (const section of requiredSections) {
    if (!persona.sections.has(section)) {
      return {
        error: `Persona "${persona.frontmatter.slug}" missing required section: ## ${section}`,
      };
    }
  }

  // Template variables
  const vars: Record<string, string> = {
    agent_name: options.agentName,
    role: persona.frontmatter.role,
    department: persona.frontmatter.department,
    emoji: persona.frontmatter.emoji,
  };

  // Generate workspace files
  const workspaceFiles: GeneratedFile[] = [];

  // IDENTITY.md
  workspaceFiles.push({
    name: "IDENTITY.md",
    content: applyTemplateVariables(generateIdentityMd(persona, options.agentName), vars),
  });

  // SOUL.md
  workspaceFiles.push({
    name: "SOUL.md",
    content: applyTemplateVariables(generateSoulMd(persona, options.agentName), vars),
  });

  // HEARTBEAT.md (optional — skip if no section)
  const heartbeat = generateHeartbeatMd(persona, options.agentName);
  if (heartbeat) {
    workspaceFiles.push({
      name: "HEARTBEAT.md",
      content: applyTemplateVariables(heartbeat, vars),
    });
  }

  // USER.md
  workspaceFiles.push({
    name: "USER.md",
    content: applyTemplateVariables(generateUserMd(persona, options.agentName), vars),
  });

  // TOOLS.md — from system template
  try {
    const toolsContent = await loadSystemTemplate("TOOLS.md");
    workspaceFiles.push({ name: "TOOLS.md", content: toolsContent });
  } catch {
    // Template not available in test environment — skip
  }

  // BOOTSTRAP.md — from system template
  try {
    const bootstrapContent = await loadSystemTemplate("BOOTSTRAP.md");
    workspaceFiles.push({ name: "BOOTSTRAP.md", content: bootstrapContent });
  } catch {
    // Template not available in test environment — skip
  }

  // Generate unified AGENT.md
  const agentMd = applyTemplateVariables(generateAgentMd(persona, options), vars);

  return { agentMd, workspaceFiles };
}
