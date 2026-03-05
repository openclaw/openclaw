#!/usr/bin/env tsx
/**
 * Clean build artifacts, node_modules, and cache files
 */

import { readdirSync, statSync, existsSync, rmSync } from "fs";
import { join } from "path";

interface CleanOptions {
  dist?: boolean;
  nodeModules?: boolean;
  cache?: boolean;
  all?: boolean;
  dryRun?: boolean;
}

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function removeDirectory(path: string, dryRun: boolean = false): boolean {
  if (!existsSync(path)) return false;

  if (dryRun) {
    log(`  [DRY RUN] Would remove: ${path}`, "yellow");
    return true;
  }

  try {
    rmSync(path, { recursive: true, force: true });
    log(`  ✓ Removed: ${path}`, "green");
    return true;
  } catch {
    log(`  ✗ Failed to remove: ${path}`, "red");
    return false;
  }
}

function cleanDirectory(
  basePath: string,
  targetDir: string,
  dryRun: boolean = false,
): number {
  let count = 0;

  function traverse(currentPath: string) {
    if (!existsSync(currentPath)) return;

    const items = readdirSync(currentPath);

    for (const item of items) {
      const itemPath = join(currentPath, item);

      if (!statSync(itemPath).isDirectory()) continue;

      if (item === targetDir) {
        if (removeDirectory(itemPath, dryRun)) count++;
      } else if (!item.startsWith(".") && !item.startsWith("_")) {
        traverse(itemPath);
      }
    }
  }

  traverse(basePath);
  return count;
}

function clean(options: CleanOptions) {
  const { dist, nodeModules, cache, all, dryRun } = options;

  log("🧹 Starting cleanup...", "blue");

  if (dryRun) {
    log("\n⚠️  DRY RUN MODE - No files will be deleted\n", "yellow");
  }

  let totalRemoved = 0;

  // Clean dist directories
  if (dist || all) {
    log("\n📦 Cleaning dist directories...", "cyan");

    const packagesRemoved = cleanDirectory(
      join(process.cwd(), "packages"),
      "dist",
      dryRun,
    );
    const appsRemoved = cleanDirectory(
      join(process.cwd(), "apps"),
      "dist",
      dryRun,
    );

    totalRemoved += packagesRemoved + appsRemoved;
    log(`  Removed ${packagesRemoved + appsRemoved} dist directories`, "blue");
  }

  // Clean node_modules
  if (nodeModules || all) {
    log("\n📦 Cleaning node_modules...", "cyan");

    // Root node_modules
    if (removeDirectory(join(process.cwd(), "node_modules"), dryRun)) {
      totalRemoved++;
    }

    // Package node_modules
    const packagesRemoved = cleanDirectory(
      join(process.cwd(), "packages"),
      "node_modules",
      dryRun,
    );
    const appsRemoved = cleanDirectory(
      join(process.cwd(), "apps"),
      "node_modules",
      dryRun,
    );

    totalRemoved += packagesRemoved + appsRemoved;
    log(
      `  Removed ${packagesRemoved + appsRemoved + 1} node_modules directories`,
      "blue",
    );
  }

  // Clean cache files
  if (cache || all) {
    log("\n🗑️  Cleaning cache files...", "cyan");

    const cacheFiles = [
      ".turbo",
      ".remotion",
      "tsconfig.tsbuildinfo",
      ".eslintcache",
    ];

    cacheFiles.forEach((cacheFile) => {
      if (removeDirectory(join(process.cwd(), cacheFile), dryRun)) {
        totalRemoved++;
      }
    });
  }

  // Summary
  log("\n" + "=".repeat(50), "blue");

  if (dryRun) {
    log(`Would remove ${totalRemoved} items`, "yellow");
    log("\nRun without --dry-run to actually remove files", "cyan");
  } else {
    log(`✓ Cleanup complete! Removed ${totalRemoved} items`, "green");

    if (nodeModules || all) {
      log('\n💡 Run "pnpm install" to reinstall dependencies', "cyan");
    }
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  log("\n🧹 Clean Script", "blue");
  log("\nUsage: pnpm clean [options]", "cyan");
  log("\nOptions:", "cyan");
  log("  --dist          Clean dist directories", "yellow");
  log("  --node-modules  Clean node_modules", "yellow");
  log("  --cache         Clean cache files", "yellow");
  log("  --all           Clean everything (default)", "yellow");
  log(
    "  --dry-run       Show what would be removed without removing",
    "yellow",
  );
  log("  -h, --help      Show this help message", "yellow");
  process.exit(0);
}

const options: CleanOptions = {
  dist: args.includes("--dist"),
  nodeModules: args.includes("--node-modules"),
  cache: args.includes("--cache"),
  all: args.includes("--all"),
  dryRun: args.includes("--dry-run"),
};

// If no specific options, default to --all
if (!options.dist && !options.nodeModules && !options.cache && !options.all) {
  options.all = true;
}

clean(options);
