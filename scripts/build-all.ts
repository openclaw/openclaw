#!/usr/bin/env tsx
/**
 * Build all applications and packages in the monorepo
 */

import { execSync } from "child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join } from "path";

interface BuildOptions {
  packages?: boolean;
  apps?: boolean;
}

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function getDirectories(path: string): string[] {
  if (!existsSync(path)) return [];

  return readdirSync(path).filter((name) => {
    const fullPath = join(path, name);
    return statSync(fullPath).isDirectory() && !name.startsWith(".");
  });
}

function hasPackageJson(path: string): boolean {
  return existsSync(join(path, "package.json"));
}

function hasBuildScript(pkgPath: string): boolean {
  if (!hasPackageJson(pkgPath)) return false;

  try {
    const raw = readFileSync(join(pkgPath, "package.json"), "utf8");
    const packageJson = JSON.parse(raw) as { scripts?: { build?: string } };
    return Boolean(packageJson.scripts?.build);
  } catch {
    return false;
  }
}

function buildPackage(name: string, path: string): boolean {
  log(`\n📦 Building ${name}...`, "blue");

  try {
    execSync("pnpm run build", {
      cwd: path,
      stdio: "inherit",
    });
    log(`✓ ${name} built successfully`, "green");
    return true;
  } catch {
    log(`✗ ${name} build failed`, "red");
    return false;
  }
}

function buildAll(options: BuildOptions = {}) {
  const { packages: buildPackages = true, apps: buildApps = true } = options;

  log("🚀 Starting monorepo build...", "blue");

  const failures: string[] = [];

  // Build packages first (dependencies)
  if (buildPackages) {
    log("\n📦 Building packages...", "yellow");

    const packagesDir = join(process.cwd(), "packages");
    const packageScopes = getDirectories(packagesDir);

    for (const scope of packageScopes) {
      const scopePath = join(packagesDir, scope);
      const packages = getDirectories(scopePath);

      for (const pkg of packages) {
        const pkgPath = join(scopePath, pkg);
        if (hasBuildScript(pkgPath)) {
          const success = buildPackage(`${scope}/${pkg}`, pkgPath);
          if (!success) failures.push(`${scope}/${pkg}`);
        }
      }
    }
  }

  // Build apps
  if (buildApps) {
    log("\n🎬 Building apps...", "yellow");

    const appsDir = join(process.cwd(), "apps");
    const apps = getDirectories(appsDir).filter(
      (name) => !name.startsWith("_") && !name.includes("template"),
    );

    for (const app of apps) {
      const appPath = join(appsDir, app);
      if (hasBuildScript(appPath)) {
        const success = buildPackage(app, appPath);
        if (!success) failures.push(app);
      }
    }
  }

  // Summary
  log("\n" + "=".repeat(50), "blue");
  if (failures.length === 0) {
    log("✓ All builds completed successfully!", "green");
  } else {
    log(`✗ ${failures.length} build(s) failed:`, "red");
    failures.forEach((name) => log(`  - ${name}`, "red"));
    process.exit(1);
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options: BuildOptions = {
  packages: !args.includes("--no-packages"),
  apps: !args.includes("--no-apps"),
};

if (args.includes("--packages-only")) {
  options.apps = false;
}

if (args.includes("--apps-only")) {
  options.packages = false;
}

buildAll(options);
