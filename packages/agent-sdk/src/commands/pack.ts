// @openclaw/agent-sdk — Pack command: validate manifest, hash files, generate integrity manifest.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { hashFile } from "../hash.js";
import type {
  AgentPackageManifest,
  IntegrityManifest,
  FileCopyEntry,
  SkillDeclaration,
} from "../index.js";

function loadManifest(packagePath: string): AgentPackageManifest {
  const manifestPath = resolve(packagePath, "agent-package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`agent-package.json not found in ${packagePath}`);
  }
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw) as AgentPackageManifest;
}

function validateRequiredFields(manifest: AgentPackageManifest): string[] {
  const errors: string[] = [];
  if (!manifest.name) errors.push("name is required");
  if (!manifest.version) errors.push("version is required");
  if (!manifest.description) errors.push("description is required");
  if (!manifest.files) {
    errors.push("files is required");
  } else {
    if (!manifest.files.copy) errors.push("files.copy is required");
    if (!manifest.files.mutable) errors.push("files.mutable is required");
  }
  return errors;
}

function validateCopyEntries(
  manifest: AgentPackageManifest,
  packagePath: string,
): { resolved: Map<string, string>; errors: string[] } {
  const resolved = new Map<string, string>();
  const errors: string[] = [];

  for (const entry of manifest.files.copy) {
    const srcPath = resolve(packagePath, entry.src);
    if (!existsSync(srcPath)) {
      errors.push(`files.copy: src not found: ${entry.src} (resolved: ${srcPath})`);
      continue;
    }
    const hash = hashFile(srcPath);
    resolved.set(entry.dest, hash);
  }

  return { resolved, errors };
}

function hashSkillFiles(
  skills: SkillDeclaration[] | undefined,
  packagePath: string,
): { resolved: Map<string, string>; errors: string[] } {
  const resolved = new Map<string, string>();
  const errors: string[] = [];

  if (!skills) return { resolved, errors };

  for (const skill of skills) {
    const skillMdPath = resolve(packagePath, skill.path, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      if (skill.required !== false) {
        errors.push(`skills: required SKILL.md not found: ${skill.path}/SKILL.md`);
      }
      continue;
    }
    const relPath = `${skill.path}/SKILL.md`;
    const hash = hashFile(skillMdPath);
    resolved.set(relPath, hash);
  }

  return { resolved, errors };
}

export const packCommand = new Command("pack")
  .description("Validate manifest, hash files, generate openclaw.integrity.json")
  .argument("[path]", "Package directory", ".")
  .action(async (packagePath: string) => {
    const resolved = resolve(packagePath);

    let manifest: AgentPackageManifest;
    try {
      manifest = loadManifest(resolved);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }

    const fieldErrors = validateRequiredFields(manifest);
    if (fieldErrors.length > 0) {
      console.error("Validation failed:");
      for (const e of fieldErrors) console.error(`  - ${e}`);
      process.exit(1);
    }

    const { resolved: fileHashes, errors: fileErrors } = validateCopyEntries(manifest, resolved);
    const { resolved: skillHashes, errors: skillErrors } = hashSkillFiles(
      manifest.skills,
      resolved,
    );

    const allErrors = [...fileErrors, ...skillErrors];
    if (allErrors.length > 0) {
      console.error("Pack failed:");
      for (const e of allErrors) console.error(`  - ${e}`);
      process.exit(1);
    }

    const integrity: IntegrityManifest = {
      version: 1,
      algorithm: "sha256",
      package: {
        name: manifest.name,
        version: manifest.version,
      },
      files: Object.fromEntries(fileHashes),
      skills: Object.fromEntries(skillHashes),
      generatedAt: new Date().toISOString(),
    };

    const outputPath = resolve(resolved, "openclaw.integrity.json");
    writeFileSync(outputPath, JSON.stringify(integrity, null, 2) + "\n", "utf8");

    console.log(`Integrity manifest written to ${outputPath}`);
    console.log(`  Files tracked: ${fileHashes.size}`);
    console.log(`  Skills tracked: ${skillHashes.size}`);
  });
