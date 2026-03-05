#!/usr/bin/env tsx
/**
 * Analyze bundle sizes across packages and apps
 */

import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

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

function getDirectorySize(dir: string): number {
  let size = 0;

  function traverse(currentPath: string) {
    try {
      const stats = statSync(currentPath);
      if (stats.isDirectory()) {
        const files = readdirSync(currentPath);
        files.forEach((file) => traverse(join(currentPath, file)));
      } else {
        size += stats.size;
      }
    } catch {
      // Skip inaccessible files
    }
  }

  if (existsSync(dir)) {
    traverse(dir);
  }

  return size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function analyzePackages() {
  log("\n📦 Analyzing package bundle sizes...", "blue");

  const packagesDir = join(process.cwd(), "packages");
  const scopes = readdirSync(packagesDir).filter((name) =>
    statSync(join(packagesDir, name)).isDirectory(),
  );

  const results: Array<{ name: string; size: number }> = [];

  for (const scope of scopes) {
    const scopePath = join(packagesDir, scope);
    const packages = readdirSync(scopePath).filter((name) =>
      statSync(join(scopePath, name)).isDirectory(),
    );

    for (const pkg of packages) {
      const distPath = join(scopePath, pkg, "dist");
      const size = getDirectorySize(distPath);
      if (size > 0) {
        results.push({ name: `${scope}/${pkg}`, size });
      }
    }
  }

  results.sort((a, b) => b.size - a.size);

  log("\n  Package                Size", "cyan");
  log("  " + "─".repeat(40), "cyan");
  results.forEach(({ name, size }) => {
    const sizeStr = formatBytes(size).padStart(10);
    log(`  ${name.padEnd(25)} ${sizeStr}`, size > 100000 ? "yellow" : "reset");
  });

  const totalSize = results.reduce((sum, { size }) => sum + size, 0);
  log("\n  " + "─".repeat(40), "cyan");
  log(
    `  Total                    ${formatBytes(totalSize).padStart(10)}`,
    "blue",
  );
}

function analyzeApps() {
  log("\n🎬 Analyzing app bundle sizes...", "blue");

  const appsDir = join(process.cwd(), "apps");
  if (!existsSync(appsDir)) {
    log("  No apps directory found", "yellow");
    return;
  }

  const apps = readdirSync(appsDir).filter((name) => {
    const appPath = join(appsDir, name);
    return (
      statSync(appPath).isDirectory() &&
      !name.startsWith("_") &&
      !name.includes("template")
    );
  });

  const results: Array<{ name: string; size: number }> = [];

  for (const app of apps) {
    const buildPath = join(appsDir, app, "dist");
    const size = getDirectorySize(buildPath);
    if (size > 0) {
      results.push({ name: app, size });
    }
  }

  if (results.length === 0) {
    log("  No built apps found", "yellow");
    return;
  }

  results.sort((a, b) => b.size - a.size);

  log("\n  App                      Size", "cyan");
  log("  " + "─".repeat(40), "cyan");
  results.forEach(({ name, size }) => {
    const sizeStr = formatBytes(size).padStart(10);
    log(`  ${name.padEnd(25)} ${sizeStr}`, size > 1000000 ? "yellow" : "reset");
  });

  const totalSize = results.reduce((sum, { size }) => sum + size, 0);
  log("\n  " + "─".repeat(40), "cyan");
  log(
    `  Total                    ${formatBytes(totalSize).padStart(10)}`,
    "blue",
  );
}

log("🔍 Bundle Size Analysis", "blue");
log("=".repeat(50), "blue");

analyzePackages();
analyzeApps();

log("\n" + "=".repeat(50), "blue");
log("✓ Analysis complete", "green");
