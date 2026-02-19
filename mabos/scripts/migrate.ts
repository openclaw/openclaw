#!/usr/bin/env node
/**
 * MABOS Migration Script
 *
 * Migrates data from ~/.openclaw/ to ~/.mabos/
 * Invoked via: mabos migrate
 *
 * Steps:
 *  1. Detect ~/.openclaw/ directory
 *  2. Create ~/.mabos/ if it doesn't exist
 *  3. Copy workspace data (businesses, agents, memory, credentials)
 *  4. Translate openclaw.json → mabos.json (rename config keys)
 *  5. Print summary
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, cp, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface MigrationResult {
  success: boolean;
  sourceDir: string;
  targetDir: string;
  itemsCopied: string[];
  configMigrated: boolean;
  errors: string[];
}

const WORKSPACE_DIRS = ["agents", "businesses", "memory", "channels", "credentials"] as const;

export async function migrate(opts?: { dryRun?: boolean }): Promise<MigrationResult> {
  const home = homedir();
  const sourceDir = join(home, ".openclaw");
  const targetDir = join(home, ".mabos");

  const result: MigrationResult = {
    success: false,
    sourceDir,
    targetDir,
    itemsCopied: [],
    configMigrated: false,
    errors: [],
  };

  // 1. Check source exists
  if (!existsSync(sourceDir)) {
    result.errors.push(`Source directory not found: ${sourceDir}`);
    return result;
  }

  console.log(`Migrating from ${sourceDir} → ${targetDir}`);

  if (opts?.dryRun) {
    console.log("[dry-run] No files will be modified.\n");
  }

  // 2. Create target directory
  if (!opts?.dryRun) {
    await mkdir(targetDir, { recursive: true });
  }
  console.log(`  Created ${targetDir}`);

  // 3. Copy workspace data
  const workspaceSource = join(sourceDir, "workspace");
  const workspaceTarget = join(targetDir, "workspace");

  if (existsSync(workspaceSource)) {
    for (const dir of WORKSPACE_DIRS) {
      const src = join(workspaceSource, dir);
      const dst = join(workspaceTarget, dir);

      if (existsSync(src)) {
        try {
          const s = await stat(src);
          if (s.isDirectory()) {
            const entries = await readdir(src);
            if (entries.length > 0) {
              if (!opts?.dryRun) {
                await cp(src, dst, { recursive: true });
              }
              result.itemsCopied.push(`workspace/${dir} (${entries.length} items)`);
              console.log(`  Copied workspace/${dir} (${entries.length} items)`);
            }
          }
        } catch (err) {
          const msg = `Failed to copy ${dir}: ${err instanceof Error ? err.message : String(err)}`;
          result.errors.push(msg);
          console.error(`  ERROR: ${msg}`);
        }
      }
    }

    // Also copy extensions/mabos data (if any agent-specific runtime data)
    const extSource = join(workspaceSource, "extensions", "mabos");
    if (existsSync(extSource)) {
      const extTarget = join(workspaceTarget, "extensions", "mabos");
      try {
        if (!opts?.dryRun) {
          await cp(extSource, extTarget, { recursive: true });
        }
        result.itemsCopied.push("workspace/extensions/mabos");
        console.log("  Copied workspace/extensions/mabos");
      } catch {
        // Non-critical
      }
    }
  }

  // 4. Migrate config: openclaw.json → mabos.json
  const configSource = join(sourceDir, "openclaw.json");
  const configTarget = join(targetDir, "mabos.json");

  if (existsSync(configSource)) {
    try {
      const configRaw = await readFile(configSource, "utf-8");
      let config = JSON.parse(configRaw);

      // Rename known config keys that reference "openclaw"
      if (config.openclaw) {
        config.mabos = config.openclaw;
        delete config.openclaw;
      }

      if (!opts?.dryRun) {
        await writeFile(configTarget, JSON.stringify(config, null, 2), "utf-8");
      }

      result.configMigrated = true;
      console.log("  Migrated openclaw.json → mabos.json");
    } catch (err) {
      const msg = `Config migration failed: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      console.error(`  ERROR: ${msg}`);
    }
  } else {
    console.log("  No openclaw.json found (skipping config migration)");
  }

  // 5. Copy credentials
  const credsSource = join(sourceDir, "credentials");
  const credsTarget = join(targetDir, "credentials");
  if (existsSync(credsSource)) {
    try {
      if (!opts?.dryRun) {
        await cp(credsSource, credsTarget, { recursive: true });
      }
      result.itemsCopied.push("credentials");
      console.log("  Copied credentials");
    } catch (err) {
      const msg = `Credentials copy failed: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
    }
  }

  // Summary
  result.success = result.errors.length === 0;

  console.log("\n" + "=".repeat(50));
  console.log("Migration Summary:");
  console.log(`  Items copied: ${result.itemsCopied.length}`);
  console.log(`  Config migrated: ${result.configMigrated ? "yes" : "no"}`);
  console.log(`  Errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log(`  Status: ${result.success ? "SUCCESS" : "PARTIAL (see errors)"}`);
  console.log("=".repeat(50));

  if (!opts?.dryRun) {
    console.log(`\nMABOS state directory: ${targetDir}`);
    console.log("You can now use 'mabos' CLI — it will read from ~/.mabos/");
  }

  return result;
}

// CLI entry point
if (process.argv[1] && process.argv[1].includes("migrate")) {
  const dryRun = process.argv.includes("--dry-run");
  migrate({ dryRun }).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
