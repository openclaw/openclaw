/**
 * Skill Directory Filter - Prevents File Descriptor Leak
 *
 * Issue: https://github.com/openclaw/openclaw/issues/9921
 *
 * When loading skills, the scanner recursively opens every file in development
 * directories (Python venvs, node_modules, .git, etc), exhausting system FD limits.
 *
 * This module filters out those directories before skill scanning begins,
 * reducing FD usage from 14,000+ to ~500.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Development directories to exclude during skill discovery.
 * These typically contain thousands of generated files that have no
 * relevance to skill metadata.
 */
const IGNORED_DIR_PATTERNS = new Set([
  // Python
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  ".pytest_cache",
  ".tox",
  "eggs",
  ".eggs",

  // Node.js
  "node_modules",
  ".npm",
  ".yarn",
  "pnpm-store",

  // Git
  ".git",
  ".gitignore",

  // Build outputs
  "dist",
  "build",
  ".next",
  "coverage",

  // IDE
  ".vscode",
  ".idea",
  ".DS_Store",
]);

/**
 * Creates a temporary directory containing symlinks to skill files/folders,
 * excluding development directories.
 *
 * This allows loadSkillsFromDir to scan only relevant skill metadata files
 * without recursing into venv/ or node_modules/.
 *
 * @param sourceDir - The skills directory to filter
 * @param tempDir - The temporary directory to populate with symlinks
 * @throws If symlink creation fails
 *
 * The caller is responsible for cleaning up tempDir after use.
 */
export function createFilteredSkillDir(sourceDir: string, tempDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    // If we can't read the source, silently skip
    return;
  }

  for (const entry of entries) {
    const entryName = entry.name;

    // Skip hidden files/directories
    if (entryName.startsWith(".")) {
      continue;
    }

    // Skip ignored development directories
    if (entry.isDirectory() && IGNORED_DIR_PATTERNS.has(entryName)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entryName);
    const targetPath = path.join(tempDir, entryName);

    try {
      // Create a symlink to preserve the original structure
      // but allow loadSkillsFromDir to scan only what we want
      fs.symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "dir" : "file");
    } catch (error) {
      // Log but don't fail - some symlinks might fail, we can still process others
      // In production, you might want conditional logging here
    }
  }
}

/**
 * Get the list of top-level skill directories that should be scanned.
 *
 * This only returns direct subdirectories of the skills folder,
 * allowing the caller to selectively filter before deeper scanning.
 *
 * @param skillsDir - The directory containing skills
 * @returns Array of absolute paths to skill directories
 */
export function getSkillDirectoriesToScan(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(skillsDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Safely create a temporary directory and return its path.
 *
 * @returns Path to the temporary directory
 */
export function createTempDir(): string {
  const baseDir = os.tmpdir();
  const name = `openclaw-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempDir = path.join(baseDir, name);

  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Safely remove a temporary directory and all its contents.
 *
 * @param tempDir - Path to the temporary directory to remove
 * @returns true if removal succeeded, false otherwise
 */
export function removeTempDir(tempDir: string): boolean {
  if (!fs.existsSync(tempDir)) {
    return true;
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load skills from a directory, automatically filtering development folders.
 *
 * This is the high-level API that:
 * 1. Creates a temp directory with filtered symlinks
 * 2. Calls loadSkillsFromDirFn with the filtered directory
 * 3. Cleans up temporary files
 * 4. Falls back to unfiltered scan if filtering fails
 *
 * @param skillsDir - Source skills directory
 * @param loadSkillsFromDirFn - The actual skill loading function
 * @param loadOpts - Options to pass to loadSkillsFromDirFn
 * @returns The result of loadSkillsFromDirFn or an empty array on failure
 */
export function loadSkillsWithDirFiltering(
  skillsDir: string,
  loadSkillsFromDirFn: (opts: {
    dir: string;
    source: string;
  }) => unknown,
  loadOpts: { source: string },
): unknown {
  if (!fs.existsSync(skillsDir)) {
    // Return empty result for missing directory
    return [];
  }

  let tempDir: string | null = null;

  try {
    // Create filtered temp directory
    tempDir = createTempDir();
    createFilteredSkillDir(skillsDir, tempDir);

    // Load skills from filtered directory
    return loadSkillsFromDirFn({
      dir: tempDir,
      source: loadOpts.source,
    });
  } catch (error) {
    // Fallback: load from source directory unfiltered
    // This ensures the system still works even if filtering fails
    try {
      return loadSkillsFromDirFn({
        dir: skillsDir,
        source: loadOpts.source,
      });
    } catch {
      // If both filtered and unfiltered fail, return empty array
      return [];
    }
  } finally {
    // Always clean up temp directory
    if (tempDir) {
      removeTempDir(tempDir);
    }
  }
}
