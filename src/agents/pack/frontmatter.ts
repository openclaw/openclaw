/**
 * PACK.md frontmatter parsing — extracts PackMetadata from YAML frontmatter.
 */
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import type { PackMetadata } from "./types.js";

export type ParsedPackFrontmatter = Record<string, string>;

export function parsePackFrontmatter(content: string): ParsedPackFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseStringList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  // Handle JSON array format from YAML parser: ["a","b"]
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string").map((s) => s.trim());
    }
  } catch {
    // Not JSON — fall through to comma-split
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract PackMetadata from parsed frontmatter fields.
 */
export function resolvePackMetadata(frontmatter: ParsedPackFrontmatter): PackMetadata {
  const name = frontmatter.name?.trim() ?? "";
  const metadata: PackMetadata = { name };

  if (frontmatter.description) {
    metadata.description = frontmatter.description.trim();
  }
  if (frontmatter.author) {
    metadata.author = frontmatter.author.trim();
  }
  if (frontmatter.version) {
    metadata.version = frontmatter.version.trim();
  }

  const skills = parseStringList(frontmatter.skills);
  if (skills.length > 0) {
    metadata.skills = skills;
  }

  const tags = parseStringList(frontmatter.tags);
  if (tags.length > 0) {
    metadata.tags = tags;
  }

  return metadata;
}

/**
 * Extract the body content (after frontmatter) from PACK.md.
 */
export function extractPackDescription(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized.trim();
  }
  // Skip the closing `---` line
  const afterFrontmatter = normalized.slice(endIndex + 4);
  return afterFrontmatter.trim();
}
