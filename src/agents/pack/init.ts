/**
 * Export a workspace as an Agent Pack.
 */
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PackInitOptions, PackInitResult } from "./types.js";

const fsp = fs.promises;
const packLogger = createSubsystemLogger("pack");

/** Workspace files to include in a pack. */
const INCLUDABLE_FILES = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "HEARTBEAT.md", "BOOTSTRAP.md"];

/** Files that should become .template (user-specific). */
const TEMPLATE_FILES = ["USER.md", "TOOLS.md"];

/**
 * Generate PACK.md content with frontmatter.
 */
function generatePackMd(options: PackInitOptions): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${options.name}`);
  if (options.description) {
    lines.push(`description: ${options.description}`);
  }
  if (options.author) {
    lines.push(`author: ${options.author}`);
  }
  lines.push(`version: ${options.version ?? "1.0.0"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${options.name}`);
  lines.push("");
  if (options.description) {
    lines.push(options.description);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Export the current workspace as an Agent Pack.
 *
 * @param workspaceDir - Source workspace directory
 * @param options - Pack init options (name, output, etc.)
 */
export async function initPack(
  workspaceDir: string,
  options: PackInitOptions,
): Promise<PackInitResult> {
  const result: PackInitResult = {
    ok: false,
    packDir: "",
    files: [],
    errors: [],
  };

  const absWorkspace = path.resolve(workspaceDir);
  const outputDir = path.resolve(
    options.outputDir ?? path.join(absWorkspace, "..", options.name + "-pack"),
  );
  result.packDir = outputDir;

  try {
    await fsp.mkdir(outputDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create output directory: ${String(err)}`);
    return result;
  }

  // Generate PACK.md
  try {
    const packContent = generatePackMd(options);
    await fsp.writeFile(path.join(outputDir, "PACK.md"), packContent, "utf-8");
    result.files.push("PACK.md");
  } catch (err) {
    result.errors.push(`Failed to write PACK.md: ${String(err)}`);
  }

  // Copy includable workspace files
  for (const file of INCLUDABLE_FILES) {
    const srcPath = path.join(absWorkspace, file);
    try {
      await fsp.access(srcPath);
      await fsp.copyFile(srcPath, path.join(outputDir, file));
      result.files.push(file);
    } catch {
      // File doesn't exist in workspace — skip
    }
  }

  // Create .template versions of user-specific files
  for (const file of TEMPLATE_FILES) {
    const srcPath = path.join(absWorkspace, file);
    const templateName = file + ".template";
    try {
      await fsp.access(srcPath);
      await fsp.copyFile(srcPath, path.join(outputDir, templateName));
      result.files.push(templateName);
    } catch {
      // File doesn't exist — skip
    }
  }

  // Optionally include skills directory
  if (options.includeSkills) {
    const srcSkillsDir = path.join(absWorkspace, "skills");
    const destSkillsDir = path.join(outputDir, "skills");
    try {
      const entries = await fsp.readdir(srcSkillsDir, { withFileTypes: true });
      await fsp.mkdir(destSkillsDir, { recursive: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillMdPath = path.join(srcSkillsDir, entry.name, "SKILL.md");
        try {
          await fsp.access(skillMdPath);
          await copyDirRecursive(
            path.join(srcSkillsDir, entry.name),
            path.join(destSkillsDir, entry.name),
          );
          result.files.push(`skills/${entry.name}`);
        } catch {
          // Not a valid skill directory — skip
        }
      }
    } catch {
      // No skills/ directory — that's fine
    }
  }

  result.ok = result.errors.length === 0;
  packLogger.info(`Pack "${options.name}" created at ${outputDir}`, {
    files: result.files.length,
    errors: result.errors.length,
  });

  return result;
}

/**
 * Recursively copy a directory.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}
