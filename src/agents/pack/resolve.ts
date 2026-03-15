/**
 * Resolve a pack from a directory by reading PACK.md and scanning workspace files.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  extractPackDescription,
  parsePackFrontmatter,
  resolvePackMetadata,
} from "./frontmatter.js";
import type { PackEntry } from "./types.js";

const fsp = fs.promises;
const packLogger = createSubsystemLogger("pack");

const PACK_FILE = "PACK.md";

/** Known workspace files that a pack can include. */
const WORKSPACE_FILES = new Set([
  "SOUL.md",
  "AGENTS.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "TOOLS.md",
  "USER.md",
  "BOOTSTRAP.md",
  "config.json",
]);

/**
 * Resolve a PackEntry from a directory containing a PACK.md file.
 * Returns undefined if the directory doesn't contain a valid PACK.md.
 */
export async function resolvePack(dir: string): Promise<PackEntry | undefined> {
  const absDir = path.resolve(dir);
  const packFilePath = path.join(absDir, PACK_FILE);

  let packContent: string;
  try {
    packContent = await fsp.readFile(packFilePath, "utf-8");
  } catch {
    packLogger.debug(`No ${PACK_FILE} found in ${absDir}`);
    return undefined;
  }

  const frontmatter = parsePackFrontmatter(packContent);
  const metadata = resolvePackMetadata(frontmatter);

  if (!metadata.name) {
    packLogger.warn(`${PACK_FILE} in ${absDir} is missing required 'name' field`);
    return undefined;
  }

  const description = extractPackDescription(packContent);

  // Scan for workspace files
  const workspaceFiles: string[] = [];
  const templateFiles: string[] = [];

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    packLogger.warn(`Failed to read directory ${absDir}`);
    return undefined;
  }

  for (const entry of dirEntries) {
    if (!entry.isFile()) {
      continue;
    }
    const name = entry.name;

    if (name === PACK_FILE) {
      continue;
    }

    if (name.endsWith(".template")) {
      templateFiles.push(name);
      continue;
    }

    if (WORKSPACE_FILES.has(name)) {
      workspaceFiles.push(name);
    }
  }

  // Detect bundled skills
  const bundledSkillDirs: string[] = [];
  const skillsDir = path.join(absDir, "skills");
  try {
    const skillEntries = await fsp.readdir(skillsDir, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
      try {
        await fsp.access(skillMdPath);
        bundledSkillDirs.push(entry.name);
      } catch {
        // Not a valid skill directory — skip
      }
    }
  } catch {
    // No skills/ directory — that's fine
  }

  packLogger.debug(`Resolved pack "${metadata.name}" from ${absDir}`, {
    workspaceFiles: workspaceFiles.length,
    templateFiles: templateFiles.length,
    bundledSkills: bundledSkillDirs.length,
  });

  return {
    dir: absDir,
    packFilePath,
    metadata,
    description,
    templateFiles,
    workspaceFiles,
    bundledSkillDirs,
  };
}

/**
 * Scan a parent directory for pack directories (each containing PACK.md).
 */
export async function scanPacksDir(parentDir: string): Promise<PackEntry[]> {
  const absParent = path.resolve(parentDir);
  const packs: PackEntry[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(absParent, { withFileTypes: true });
  } catch {
    return packs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packDir = path.join(absParent, entry.name);
    const pack = await resolvePack(packDir);
    if (pack) {
      packs.push(pack);
    }
  }

  return packs;
}
