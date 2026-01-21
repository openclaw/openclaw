/**
 * Project Resolver for Claude Code Sessions
 *
 * Resolves project identifiers like "juzi" or "juzi @experimental" to
 * actual filesystem paths, handling worktrees correctly.
 *
 * Project resolution order:
 * 1. Absolute paths (starts with /)
 * 2. Explicit aliases from config (claudeCode.projects)
 * 3. Auto-discovery in config dirs (claudeCode.projectDirs)
 * 4. Auto-discovery in default dirs (hardcoded fallbacks)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import type { ResolvedProject } from "./types.js";
import { loadConfig } from "../../config/config.js";
import type { ClaudeCodeConfig } from "../../config/types.claude-code.js";

/**
 * Default project base directories to search (fallback when no config).
 */
const DEFAULT_PROJECT_BASES = [
  path.join(os.homedir(), "clawd", "projects"),
  path.join(os.homedir(), "Documents", "agent"),
  path.join(os.homedir(), "projects"),
  path.join(os.homedir(), "code"),
  path.join(os.homedir(), "dev"),
];

/**
 * Get Claude Code config from the main config file.
 */
function getClaudeCodeConfig(): ClaudeCodeConfig {
  try {
    const config = loadConfig();
    return config.claudeCode ?? {};
  } catch {
    return {};
  }
}

/**
 * Get project base directories, combining config and defaults.
 * Config dirs are searched first, then defaults.
 */
function getProjectBases(): string[] {
  const config = getClaudeCodeConfig();
  const configDirs = (config.projectDirs ?? []).map((dir) =>
    dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir,
  );
  // Config dirs first, then defaults (deduped)
  const seen = new Set<string>();
  const bases: string[] = [];
  for (const dir of [...configDirs, ...DEFAULT_PROJECT_BASES]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      bases.push(dir);
    }
  }
  return bases;
}

/**
 * Get explicit project aliases from config.
 */
function getProjectAliases(): Record<string, string> {
  const config = getClaudeCodeConfig();
  const aliases: Record<string, string> = {};
  for (const [name, dir] of Object.entries(config.projects ?? {})) {
    aliases[name] = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
  }
  return aliases;
}

/**
 * Parse project identifier into components.
 *
 * Examples:
 * - "juzi" → { name: "juzi", worktree: undefined }
 * - "juzi @experimental" → { name: "juzi", worktree: "experimental" }
 * - "/path/to/project" → absolute path
 */
export function parseProjectIdentifier(project: string): {
  name: string;
  worktree?: string;
  isAbsolute: boolean;
} {
  const trimmed = project.trim();

  // Check if it's an absolute path
  if (trimmed.startsWith("/")) {
    return { name: trimmed, isAbsolute: true };
  }

  // Check for worktree syntax: "project @branch"
  const worktreeMatch = trimmed.match(/^(.+?)\s*@\s*(.+)$/);
  if (worktreeMatch) {
    return {
      name: worktreeMatch[1].trim(),
      worktree: worktreeMatch[2].trim(),
      isAbsolute: false,
    };
  }

  return { name: trimmed, isAbsolute: false };
}

/**
 * Get git branch for a directory.
 */
export function getGitBranch(dir: string): string {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch || "main";
  } catch {
    return "main";
  }
}

/**
 * Check if a directory is a git worktree.
 */
export function isGitWorktree(dir: string): boolean {
  const gitDir = path.join(dir, ".git");
  try {
    const stat = fs.statSync(gitDir);
    // Worktrees have .git as a file, not a directory
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Find project directory by name.
 * Checks explicit aliases first, then auto-discovers in project bases.
 */
function findProjectByName(name: string): string | undefined {
  // Check explicit aliases first
  const aliases = getProjectAliases();
  if (aliases[name]) {
    const aliasPath = aliases[name];
    if (fs.existsSync(aliasPath) && fs.statSync(aliasPath).isDirectory()) {
      return aliasPath;
    }
  }

  // Auto-discover in project bases
  for (const base of getProjectBases()) {
    if (!fs.existsSync(base)) continue;

    const candidate = path.join(base, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Find worktree directory within a project.
 */
function findWorktree(projectDir: string, worktreeName: string): string | undefined {
  const worktreesDir = path.join(projectDir, ".worktrees");

  if (fs.existsSync(worktreesDir)) {
    const candidate = path.join(worktreesDir, worktreeName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  // Also check git worktree list
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice(9).trim();
        if (
          worktreePath.endsWith(`/${worktreeName}`) ||
          worktreePath.endsWith(`/.worktrees/${worktreeName}`)
        ) {
          if (fs.existsSync(worktreePath)) {
            return worktreePath;
          }
        }
      }
    }
  } catch {
    // Git worktree command not available or failed
  }

  return undefined;
}

/**
 * Extract project name from path, handling worktrees.
 */
function getDisplayName(dir: string): string {
  const normalized = dir.replace(/\/$/, "");

  // Check for worktree pattern: /path/to/project/.worktrees/branch
  const worktreeMatch = normalized.match(/(.+)\/\.worktrees\/([^/]+)$/);
  if (worktreeMatch) {
    const mainProject = path.basename(worktreeMatch[1]);
    const worktreeName = worktreeMatch[2];
    return `${mainProject} @${worktreeName}`;
  }

  return path.basename(normalized);
}

/**
 * Resolve a project identifier to a full path and metadata.
 *
 * @param project - Project identifier (e.g., "juzi", "juzi @experimental", "/abs/path")
 * @returns Resolved project info or undefined if not found
 */
export function resolveProject(project: string): ResolvedProject | undefined {
  const parsed = parseProjectIdentifier(project);

  let workingDir: string | undefined;

  if (parsed.isAbsolute) {
    // Absolute path provided
    if (fs.existsSync(parsed.name) && fs.statSync(parsed.name).isDirectory()) {
      workingDir = parsed.name;
    }
  } else if (parsed.worktree) {
    // Project with worktree: "juzi @experimental"
    const projectDir = findProjectByName(parsed.name);
    if (projectDir) {
      workingDir = findWorktree(projectDir, parsed.worktree);
    }
  } else {
    // Simple project name: "juzi"
    workingDir = findProjectByName(parsed.name);
  }

  if (!workingDir) {
    return undefined;
  }

  const displayName = getDisplayName(workingDir);
  const branch = getGitBranch(workingDir);
  const isWorktree = workingDir.includes("/.worktrees/") || isGitWorktree(workingDir);

  // Extract main project name
  let mainProject: string;
  let worktreeName: string | undefined;

  const worktreeMatch = workingDir.match(/(.+)\/\.worktrees\/([^/]+)$/);
  if (worktreeMatch) {
    mainProject = path.basename(worktreeMatch[1]);
    worktreeName = worktreeMatch[2];
  } else {
    mainProject = path.basename(workingDir);
  }

  return {
    workingDir,
    displayName,
    branch,
    isWorktree,
    mainProject,
    worktreeName,
  };
}

/**
 * Find the session file for a resume token.
 *
 * Claude Code stores sessions at:
 * ~/.claude/projects/<encoded-path>/<token>.jsonl
 */
export function findSessionFile(resumeToken: string): string | undefined {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  if (!fs.existsSync(claudeProjectsDir)) {
    return undefined;
  }

  // Search all project directories for the token
  const projectDirs = fs.readdirSync(claudeProjectsDir);

  for (const projectDir of projectDirs) {
    const fullPath = path.join(claudeProjectsDir, projectDir);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const sessionFile = path.join(fullPath, `${resumeToken}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      return sessionFile;
    }
  }

  // Try partial match (first 8 chars)
  const tokenPrefix = resumeToken.slice(0, 8);
  for (const projectDir of projectDirs) {
    const fullPath = path.join(claudeProjectsDir, projectDir);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const files = fs.readdirSync(fullPath);
    for (const file of files) {
      if (file.startsWith(tokenPrefix) && file.endsWith(".jsonl")) {
        return path.join(fullPath, file);
      }
    }
  }

  return undefined;
}

/**
 * Decode a Claude Code project path encoding.
 *
 * Claude encodes paths like:
 * /Users/dydo/clawd/projects/juzi → -Users-dydo-clawd-projects-juzi
 * Literal - becomes --
 */
export function decodeClaudeProjectPath(encoded: string): string {
  // Claude Code encoding: / → -, . → -
  // So /. (hidden dir like /.worktrees) becomes --
  // We need to decode: -- → /., then - → /
  const PLACEHOLDER = "\x00";
  let decoded = encoded.replace(/--/g, PLACEHOLDER);
  decoded = decoded.replace(/-/g, "/");
  decoded = decoded.replace(new RegExp(PLACEHOLDER, "g"), "/.");
  return decoded;
}

/**
 * Encode a path for Claude Code project directory.
 *
 * Claude Code encodes paths:
 * - `-` → `--` (escape existing dashes)
 * - `/` → `-`
 * - `.` → `-`
 *
 * Example: `/Users/dydo/juzi/.worktrees/exp` → `-Users-dydo-juzi--worktrees-exp`
 */
export function encodeClaudeProjectPath(dir: string): string {
  // Replace - with --, then / with -, then . with -
  let encoded = dir.replace(/-/g, "--");
  encoded = encoded.replace(/\//g, "-");
  encoded = encoded.replace(/\./g, "-");
  return encoded;
}

/**
 * Get the expected session directory for a project.
 */
export function getSessionDir(workingDir: string): string {
  const encoded = encodeClaudeProjectPath(workingDir);
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

/**
 * List all known projects (explicit aliases + auto-discovered).
 */
export function listKnownProjects(): Array<{
  name: string;
  path: string;
  source: "alias" | "discovered";
}> {
  const results: Array<{ name: string; path: string; source: "alias" | "discovered" }> = [];
  const seen = new Set<string>();

  // Explicit aliases first
  const aliases = getProjectAliases();
  for (const [name, dir] of Object.entries(aliases)) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      results.push({ name, path: dir, source: "alias" });
      seen.add(name);
    }
  }

  // Auto-discovered projects
  for (const base of getProjectBases()) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base);
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        const fullPath = path.join(base, entry);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            results.push({ name: entry, path: fullPath, source: "discovered" });
            seen.add(entry);
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get the current project bases (for display purposes).
 */
export function getConfiguredProjectBases(): string[] {
  return getProjectBases();
}

/**
 * Get the default permission mode from config.
 */
export function getDefaultPermissionMode(): "default" | "acceptEdits" | "bypassPermissions" {
  const config = getClaudeCodeConfig();
  return config.permissionMode ?? "default";
}

/**
 * Get the default model from config.
 */
export function getDefaultModel(): string | undefined {
  const config = getClaudeCodeConfig();
  return config.model;
}
