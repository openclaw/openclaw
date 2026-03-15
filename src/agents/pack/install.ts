/**
 * Install a pack into a target workspace directory.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolvePack } from "./resolve.js";
import type { PackInstallOptions, PackInstallResult } from "./types.js";

const fsp = fs.promises;
const packLogger = createSubsystemLogger("pack");

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<string[]> {
  const copied: string[] = [];
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const subCopied = await copyDir(srcPath, destPath);
      copied.push(...subCopied);
    } else {
      await fsp.copyFile(srcPath, destPath);
      copied.push(destPath);
    }
  }
  return copied;
}

/**
 * Install a pack from `packDir` into a target workspace.
 */
export async function installPack(
  packDir: string,
  options?: PackInstallOptions,
): Promise<PackInstallResult> {
  const result: PackInstallResult = {
    ok: false,
    workspaceDir: "",
    copiedFiles: [],
    skippedFiles: [],
    installedSkills: [],
    errors: [],
  };

  const pack = await resolvePack(packDir);
  if (!pack) {
    result.errors.push(`No valid pack found in ${packDir}`);
    return result;
  }

  const force = options?.force ?? false;
  const skipSkills = options?.skipSkills ?? false;

  // Determine target workspace directory
  const workspaceDir = path.resolve(options?.workdir ?? pack.metadata.name);
  result.workspaceDir = workspaceDir;

  try {
    await fsp.mkdir(workspaceDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create workspace directory: ${String(err)}`);
    return result;
  }

  // Copy workspace files
  for (const file of pack.workspaceFiles) {
    const srcPath = path.join(pack.dir, file);
    const destPath = path.join(workspaceDir, file);
    try {
      if (!force) {
        try {
          await fsp.access(destPath);
          result.skippedFiles.push(file);
          packLogger.debug(`Skipped existing file: ${file}`);
          continue;
        } catch {
          // File doesn't exist — proceed to copy
        }
      }
      await fsp.copyFile(srcPath, destPath);
      result.copiedFiles.push(file);
    } catch (err) {
      result.errors.push(`Failed to copy ${file}: ${String(err)}`);
    }
  }

  // Process template files — strip .template extension
  for (const templateFile of pack.templateFiles) {
    const targetName = templateFile.replace(/\.template$/, "");
    const srcPath = path.join(pack.dir, templateFile);
    const destPath = path.join(workspaceDir, targetName);
    try {
      if (!force) {
        try {
          await fsp.access(destPath);
          result.skippedFiles.push(targetName);
          packLogger.debug(`Skipped existing template target: ${targetName}`);
          continue;
        } catch {
          // File doesn't exist — proceed
        }
      }
      await fsp.copyFile(srcPath, destPath);
      result.copiedFiles.push(targetName);
    } catch (err) {
      result.errors.push(`Failed to copy template ${templateFile} → ${targetName}: ${String(err)}`);
    }
  }

  // Copy bundled skills
  if (!skipSkills && pack.bundledSkillDirs.length > 0) {
    const targetSkillsDir = path.join(workspaceDir, "skills");
    try {
      await fsp.mkdir(targetSkillsDir, { recursive: true });
    } catch (err) {
      result.errors.push(`Failed to create skills directory: ${String(err)}`);
    }

    for (const skillName of pack.bundledSkillDirs) {
      const srcSkillDir = path.join(pack.dir, "skills", skillName);
      const destSkillDir = path.join(targetSkillsDir, skillName);
      try {
        if (!force) {
          try {
            await fsp.access(destSkillDir);
            result.skippedFiles.push(`skills/${skillName}`);
            packLogger.debug(`Skipped existing skill: ${skillName}`);
            continue;
          } catch {
            // Skill dir doesn't exist — proceed
          }
        }
        await copyDir(srcSkillDir, destSkillDir);
        result.installedSkills.push(skillName);
      } catch (err) {
        result.errors.push(`Failed to install skill ${skillName}: ${String(err)}`);
      }
    }
  }

  // Copy PACK.md to workspace for reference
  const packMdDest = path.join(workspaceDir, "PACK.md");
  try {
    if (
      force ||
      !(await fsp
        .access(packMdDest)
        .then(() => true)
        .catch(() => false))
    ) {
      await fsp.copyFile(pack.packFilePath, packMdDest);
      result.copiedFiles.push("PACK.md");
    }
  } catch (err) {
    result.errors.push(`Failed to copy PACK.md: ${String(err)}`);
  }

  result.ok = result.errors.length === 0;
  packLogger.info(`Pack "${pack.metadata.name}" installed to ${workspaceDir}`, {
    copied: result.copiedFiles.length,
    skipped: result.skippedFiles.length,
    skills: result.installedSkills.length,
    errors: result.errors.length,
  });

  return result;
}
