import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type SkillMetadata = {
  name?: string;
  description?: string;
  emoji?: string;
};

export type SkillsLockEntry = {
  slug: string;
  source: string;
  installedAt: string;
  installedFrom: "skills.sh";
};

export type SkillsLock = Record<string, SkillsLockEntry>;

/** Parse YAML frontmatter from a SKILL.md file (lightweight, no deps). */
export function parseSkillFrontmatter(content: string): SkillMetadata {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }

  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }

  return {
    name: result.name,
    description: result.description,
    emoji: result.emoji,
  };
}

export function readSkillsLock(workspaceRoot: string): SkillsLock {
  const lockFile = join(workspaceRoot, ".skills", "lock.json");
  if (!existsSync(lockFile)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as SkillsLock;
  } catch {
    return {};
  }
}

export function writeSkillsLock(workspaceRoot: string, lock: SkillsLock): void {
  const lockDir = join(workspaceRoot, ".skills");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "lock.json"), JSON.stringify(lock, null, 2));
}

const SKILL_SEARCH_DIRS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".factory/skills",
  ".goose/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".pi/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
];

const MAX_RECURSIVE_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "tmp", "dist", "build"]);

export type DiscoveredSkill = {
  dir: string;
  name: string;
};

function scanDirForSkills(dir: string): DiscoveredSkill[] {
  const results: DiscoveredSkill[] = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) {
        results.push({ dir: join(dir, entry.name), name: entry.name });
      }
    }
  } catch { /* unreadable */ }

  return results;
}

function recursiveScanForSkills(dir: string, depth: number): DiscoveredSkill[] {
  if (depth > MAX_RECURSIVE_DEPTH) return [];
  const results: DiscoveredSkill[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && depth > 0) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const subDir = join(dir, entry.name);
      if (existsSync(join(subDir, "SKILL.md"))) {
        results.push({ dir: subDir, name: entry.name });
      }
      results.push(...recursiveScanForSkills(subDir, depth + 1));
    }
  } catch { /* unreadable */ }

  return results;
}

/**
 * Discover all skill directories inside an extracted repository using
 * the same search strategy as the official `skills` CLI: root, well-known
 * subdirectories, then a bounded recursive fallback.
 */
export function discoverSkillsInRepo(repoRoot: string): DiscoveredSkill[] {
  if (existsSync(join(repoRoot, "SKILL.md"))) {
    return [{ dir: repoRoot, name: basename(repoRoot) }];
  }

  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const searchDir of SKILL_SEARCH_DIRS) {
    for (const skill of scanDirForSkills(join(repoRoot, searchDir))) {
      if (!seen.has(skill.dir)) {
        seen.add(skill.dir);
        found.push(skill);
      }
    }
  }

  if (found.length > 0) return found;

  return recursiveScanForSkills(repoRoot, 0);
}

/**
 * Select the best skill from discovered candidates for a given slug.
 * Returns null with an explanatory message when no unambiguous match exists.
 */
export function selectSkillForSlug(
  candidates: DiscoveredSkill[],
  slug: string,
): { skill: DiscoveredSkill } | { skill: null; reason: string } {
  if (candidates.length === 0) {
    return { skill: null, reason: "Repository does not contain any SKILL.md files" };
  }

  const exactMatch = candidates.find((c) => c.name === slug);
  if (exactMatch) return { skill: exactMatch };

  // skills.sh skillId may be prefixed (e.g. "clerk-nextjs-patterns" for folder "nextjs-patterns")
  const suffixMatch = candidates.find((c) => slug.endsWith(c.name) || slug.endsWith(`-${c.name}`));
  if (suffixMatch) return { skill: suffixMatch };

  const prefixMatch = candidates.find((c) => c.name.endsWith(slug) || c.name.endsWith(`-${slug}`));
  if (prefixMatch) return { skill: prefixMatch };

  if (candidates.length === 1) return { skill: candidates[0] };

  const names = candidates.map((c) => c.name).join(", ");
  return {
    skill: null,
    reason: `Repository contains multiple skills (${names}) but none matches "${slug}". Try installing by the exact skill name.`,
  };
}

export function removeSkillsLockEntry(workspaceRoot: string, slug: string): void {
  const lock = readSkillsLock(workspaceRoot);
  if (!(slug in lock)) {
    return;
  }
  delete lock[slug];
  writeSkillsLock(workspaceRoot, lock);
}
