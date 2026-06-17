// @openclaw/agent-sdk — Validate command: schema + integrity + mutable instruction policy.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Command } from "commander";
import { hashFile } from "../hash.js";
import { INSTRUCTION_FILES } from "../index.js";
import type { AgentPackageManifest, IntegrityManifest, ValidationResult } from "../index.js";

const INSTRUCTION_FILE_SET = new Set<string>(INSTRUCTION_FILES);

function loadJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function validateSchema(manifest: AgentPackageManifest): string[] {
  const errors: string[] = [];
  if (!manifest.name) errors.push("name is required");
  if (!manifest.version) errors.push("version is required");
  if (!manifest.description) errors.push("description is required");
  if (!manifest.files) errors.push("files is required");
  if (!Array.isArray(manifest.files.copy)) errors.push("files.copy must be an array");
  if (!Array.isArray(manifest.files.mutable)) errors.push("files.mutable must be an array");

  // Validate policy fields
  if (manifest.policy) {
    const validUpgrades = ["preserve-custom", "reset", "prompt"];
    if (manifest.policy.onUpgrade && !validUpgrades.includes(manifest.policy.onUpgrade)) {
      errors.push(`policy.onUpgrade must be one of: ${validUpgrades.join(", ")}`);
    }
  }

  // Validate secrets
  if (manifest.secrets) {
    if (!Array.isArray(manifest.secrets.consumer)) {
      errors.push("secrets.consumer must be an array");
    }
    if (typeof manifest.secrets.mapping !== "object" || manifest.secrets.mapping === null) {
      errors.push("secrets.mapping must be an object");
    }
    // Every consumer must have a mapping
    if (Array.isArray(manifest.secrets.consumer) && typeof manifest.secrets.mapping === "object") {
      for (const c of manifest.secrets.consumer) {
        if (!(c.name in manifest.secrets.mapping)) {
          errors.push(`secrets.mapping missing for consumer: ${c.name}`);
        }
      }
    }
  }

  // Validate tools
  if (manifest.tools?.sandbox?.network) {
    const validEgress = ["full", "restricted", "none"];
    const egress = manifest.tools.sandbox.network.egress;
    if (egress && !validEgress.includes(egress)) {
      errors.push(`tools.sandbox.network.egress must be one of: ${validEgress.join(", ")}`);
    }
  }

  // Validate schedules
  if (manifest.schedules) {
    for (const s of manifest.schedules) {
      if (!s.name) errors.push("schedule.name is required");
      if (!s.cron) errors.push(`schedule "${s.name || "(unnamed)"}": cron is required`);
      if (!s.payload) errors.push(`schedule "${s.name || "(unnamed)"}": payload is required`);
      if (s.payload && !["agentTurn", "systemEvent"].includes(s.payload.kind)) {
        errors.push(
          `schedule "${s.name || "(unnamed)"}": payload.kind must be "agentTurn" or "systemEvent"`,
        );
      }
    }
  }

  return errors;
}

function hasFileArrays(manifest: AgentPackageManifest): boolean {
  return (
    typeof manifest.files === "object" &&
    manifest.files !== null &&
    Array.isArray(manifest.files.copy) &&
    Array.isArray(manifest.files.mutable)
  );
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validatePackageFile(packagePath: string, src: string): string | null {
  if (!src || isAbsolute(src)) return "absolute source paths are not allowed";
  const resolved = resolve(packagePath, src);
  if (!isInsideRoot(packagePath, resolved)) return "source path escapes package root";
  if (!existsSync(resolved)) return `source file missing: ${src}`;
  if (!lstatSync(resolved).isFile()) return "source must be a regular file";
  const real = realpathSync(resolved);
  if (!isInsideRoot(packagePath, real)) return "source resolves outside package root";
  return null;
}

function validateWorkspacePath(workspacePath: string, dest: string): string | null {
  if (!dest || isAbsolute(dest)) return "absolute destination paths are not allowed";
  const resolved = resolve(workspacePath, dest);
  if (!isInsideRoot(workspacePath, resolved)) return "destination path escapes workspace root";
  return null;
}

function validateFilePaths(manifest: AgentPackageManifest, packagePath: string): string[] {
  const errors: string[] = [];
  if (!hasFileArrays(manifest)) return errors;
  for (const entry of manifest.files.copy) {
    const srcError = validatePackageFile(packagePath, entry.src);
    if (srcError) errors.push(`files.copy src "${entry.src}": ${srcError}`);
    const destError = validateWorkspacePath(packagePath, entry.dest);
    if (destError) errors.push(`files.copy dest "${entry.dest}": ${destError}`);
  }
  for (const entry of manifest.files.mutable) {
    const destError = validateWorkspacePath(packagePath, entry.dest);
    if (destError) errors.push(`files.mutable "${entry.dest}": ${destError}`);
  }
  return errors;
}

function validateIntegrity(
  manifest: AgentPackageManifest,
  integrity: IntegrityManifest,
  packagePath: string,
): string[] {
  const errors: string[] = [];
  if (!hasFileArrays(manifest)) return errors;

  // Check package identity matches
  if (integrity.package.name !== manifest.name) {
    errors.push(
      `integrity manifest package name mismatch: "${integrity.package.name}" vs "${manifest.name}"`,
    );
  }
  if (integrity.package.version !== manifest.version) {
    errors.push(
      `integrity manifest version mismatch: "${integrity.package.version}" vs "${manifest.version}"`,
    );
  }

  // Re-hash every tracked file and compare
  for (const [dest, expectedHash] of Object.entries(integrity.files)) {
    // Find the copy entry for this dest
    const copyEntry = manifest.files.copy.find((e) => e.dest === dest);
    if (!copyEntry) {
      errors.push(`integrity tracks "${dest}" but no files.copy entry exists`);
      continue;
    }
    const filePath = resolve(packagePath, copyEntry.src);
    if (!existsSync(filePath)) {
      errors.push(`integrity tracks "${dest}" but source file missing: ${copyEntry.src}`);
      continue;
    }
    const actualHash = hashFile(filePath);
    if (actualHash !== expectedHash) {
      errors.push(`integrity mismatch for "${dest}": file has changed since pack`);
    }
  }

  // Check for copy entries not in integrity
  for (const entry of manifest.files.copy) {
    if (!(entry.dest in integrity.files)) {
      errors.push(`files.copy entry "${entry.dest}" not tracked in integrity manifest`);
    }
  }

  return errors;
}

function validateMutableInstructionPolicy(manifest: AgentPackageManifest): string[] {
  const errors: string[] = [];
  if (!hasFileArrays(manifest)) return errors;
  const denyMutable = manifest.policy?.denyMutableInstructionFiles !== false; // default true

  if (!denyMutable) return errors;

  const allowUser = manifest.policy?.allowMutableUserInstructionFiles === true;

  for (const mutableEntry of manifest.files.mutable) {
    const dest = mutableEntry.dest;

    // Check if any instruction file would fall under this mutable path
    for (const instrFile of INSTRUCTION_FILE_SET) {
      if (instrFile === "USER.md" && allowUser) continue;

      // Exact match or parent directory match
      if (
        dest === instrFile ||
        dest.endsWith(`/${instrFile}`) ||
        instrFile.startsWith(`${dest}/`)
      ) {
        errors.push(
          `mutable path "${dest}" contains instruction file "${instrFile}" but denyMutableInstructionFiles is true`,
        );
      }
    }

    // Check if any copied file's dest falls under a mutable path
    for (const copyEntry of manifest.files.copy) {
      if (copyEntry.dest === dest || copyEntry.dest.startsWith(`${dest}/`)) {
        errors.push(
          `mutable path "${dest}" overlaps with copied file "${copyEntry.dest}" — copied files are immutable`,
        );
      }
    }
  }

  return errors;
}

export function runValidation(packagePath: string): {
  result: ValidationResult;
  integrity: IntegrityManifest | null;
} {
  const resolved = resolve(packagePath);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Load manifest
  const manifestPath = resolve(resolved, "agent-package.json");
  if (!existsSync(manifestPath)) {
    return {
      result: {
        valid: false,
        errors: [{ path: "agent-package.json", message: "not found" }],
        warnings: [],
      },
      integrity: null,
    };
  }

  let manifest: AgentPackageManifest;
  try {
    manifest = loadJSON<AgentPackageManifest>(manifestPath);
  } catch (e) {
    return {
      result: {
        valid: false,
        errors: [{ path: "agent-package.json", message: `parse error: ${(e as Error).message}` }],
        warnings: [],
      },
      integrity: null,
    };
  }

  // Schema validation
  errors.push(...validateSchema(manifest).map((m) => ({ path: "agent-package.json", message: m })));
  errors.push(
    ...validateFilePaths(manifest, resolved).map((m) => ({
      path: "agent-package.json",
      message: m,
    })),
  );

  // Integrity check
  let integrity: IntegrityManifest | null = null;
  const integrityPath = resolve(resolved, "openclaw.integrity.json");
  if (existsSync(integrityPath)) {
    try {
      integrity = loadJSON<IntegrityManifest>(integrityPath);
      errors.push(
        ...validateIntegrity(manifest, integrity, resolved).map((m) => ({
          path: "openclaw.integrity.json",
          message: m,
        })),
      );
    } catch (e) {
      errors.push({
        path: "openclaw.integrity.json",
        message: `parse error: ${(e as Error).message}`,
      });
    }
  } else {
    warnings.push({
      path: "openclaw.integrity.json",
      message: "not found — run 'pack' to generate",
    });
  }

  // Mutable instruction file policy
  errors.push(
    ...validateMutableInstructionPolicy(manifest).map((m) => ({
      path: "agent-package.json",
      message: m,
    })),
  );

  return {
    result: {
      valid: errors.length === 0,
      errors: errors as { path: string; message: string }[],
      warnings,
    },
    integrity,
  };
}

export const validateCommand = new Command("validate")
  .description("Validate manifest schema + integrity + mutable instruction policy")
  .argument("[path]", "Package directory", ".")
  .action(async (packagePath: string) => {
    const { result } = runValidation(packagePath);

    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.warn(`  Warning: ${w.path}: ${w.message}`);
      }
    }

    if (result.errors.length > 0) {
      console.error("Validation failed:");
      for (const e of result.errors) {
        console.error(`  - ${e.path}: ${e.message}`);
      }
      process.exit(1);
    }

    console.log("Validation passed.");
  });
