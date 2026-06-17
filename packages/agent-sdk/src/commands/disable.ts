// @openclaw/agent-sdk — Disable command: remove files, unregister, clean up.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Command } from "commander";
import { hashFile } from "../hash.js";
import type { AgentPackageManifest, IntegrityManifest } from "../index.js";

function loadManifest(packagePath: string): AgentPackageManifest {
  const manifestPath = resolve(packagePath, "agent-package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`agent-package.json not found in ${packagePath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as AgentPackageManifest;
}

function loadIntegrityManifest(packagePath: string): IntegrityManifest | null {
  const integrityPath = resolve(packagePath, "openclaw.integrity.json");
  if (!existsSync(integrityPath)) return null;
  return JSON.parse(readFileSync(integrityPath, "utf8")) as IntegrityManifest;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveWorkspacePath(workspacePath: string, dest: string): string {
  if (!dest || isAbsolute(dest)) {
    throw new Error(`workspace destination must be workspace-relative: ${dest}`);
  }
  const resolved = resolve(workspacePath, dest);
  if (!isInsideRoot(workspacePath, resolved)) {
    throw new Error(`workspace destination escapes workspace root: ${dest}`);
  }
  return resolved;
}

/**
 * Remove copied files from workspace only if they haven't been modified.
 * Compares current hash against the integrity manifest.
 * Returns { removed, skipped } counts.
 */
function removeCopiedFiles(
  manifest: AgentPackageManifest,
  packagePath: string,
  workspacePath: string,
  integrity: IntegrityManifest | null,
): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const entry of manifest.files.copy) {
    const destPath = resolveWorkspacePath(workspacePath, entry.dest);

    if (!existsSync(destPath)) {
      // Already gone, nothing to do
      continue;
    }

    // Check if file has been modified since pack
    if (integrity?.files[entry.dest]) {
      const currentHash = hashFile(destPath);
      if (currentHash !== integrity.files[entry.dest]) {
        skipped.push(entry.dest);
        continue;
      }
    }

    rmSync(destPath, { force: true });
    removed.push(entry.dest);
  }

  return { removed, skipped };
}

/**
 * Remove the package from the workspace registry.
 */
function unregisterPackage(packageName: string, workspacePath: string): boolean {
  const registryPath = resolve(workspacePath, "agent-sdk-registry.json");
  if (!existsSync(registryPath)) return false;

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!(packageName in registry)) return false;

  delete registry[packageName];
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Remove a generated file from workspace if it exists.
 */
function removeGeneratedFile(filename: string, workspacePath: string): boolean {
  const filePath = resolve(workspacePath, filename);
  if (!existsSync(filePath)) return false;
  rmSync(filePath, { force: true });
  return true;
}

export const disableCommand = new Command("disable")
  .description("Remove copied files, unregister, and clean up workspace artifacts")
  .argument("[path]", "Package directory", ".")
  .option("--workspace <path>", "Target workspace directory", ".")
  .option("--force", "Remove modified files without asking", false)
  .action(async (packagePath: string, options: { workspace?: string; force?: boolean }) => {
    const resolved = resolve(packagePath);
    const workspacePath = options.workspace ? resolve(options.workspace) : resolved;

    // Step 1: Load manifest
    let manifest: AgentPackageManifest;
    try {
      manifest = loadManifest(resolved);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }

    // Step 2: Load integrity manifest for hash comparison
    const integrity = loadIntegrityManifest(resolved);

    // Step 3: Remove copied files
    const { removed, skipped } = removeCopiedFiles(manifest, resolved, workspacePath, integrity);

    if (removed.length > 0) {
      console.log(`Removed ${removed.length} files.`);
    }
    if (skipped.length > 0) {
      if (options.force) {
        // Force-remove skipped files
        for (const dest of skipped) {
          const destPath = resolveWorkspacePath(workspacePath, dest);
          rmSync(destPath, { force: true });
          removed.push(dest);
        }
        console.log(`Force-removed ${skipped.length} modified files.`);
      } else {
        console.log(`Skipped ${skipped.length} modified files (use --force to remove).`);
        for (const s of skipped) {
          console.log(`  - ${s}`);
        }
      }
    }

    // Step 4: Unregister package
    const wasRegistered = unregisterPackage(manifest.name, workspacePath);
    if (wasRegistered) {
      console.log(`Unregistered ${manifest.name}.`);
    }

    // Step 5: Remove generated config files
    const configRemoved = removeGeneratedFile("agent-sdk-config.json", workspacePath);
    const bindingsRemoved = removeGeneratedFile("agent-sdk-bindings.json", workspacePath);
    const schedulesRemoved = removeGeneratedFile("agent-sdk-schedules.json", workspacePath);

    const generatedCount = [configRemoved, bindingsRemoved, schedulesRemoved].filter(
      Boolean,
    ).length;
    if (generatedCount > 0) {
      console.log(`Removed ${generatedCount} generated config files.`);
    }

    console.log(`\n✓ ${manifest.name}@${manifest.version} disabled.`);
  });
