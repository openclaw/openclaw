#!/usr/bin/env tsx
/**
 * Forge launcher CLI:
 * Select an app by number, then run dev or render immediately.
 */

import { spawnSync } from "child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import * as readline from "readline";

type Mode = "dev" | "render";

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

function getAvailableApps(): string[] {
  const appsDir = join(process.cwd(), "apps");
  if (!existsSync(appsDir)) return [];

  const collected: string[] = [];
  const walk = (dir: string, relDir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (entry === "node_modules") continue;

      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const hasPackageJson = existsSync(join(fullPath, "package.json"));
      if (hasPackageJson) {
        if (
          !entry.startsWith("_") &&
          !entry.toLowerCase().includes("template") &&
          !relPath.toLowerCase().includes("/_") &&
          resolveEntryPoint(fullPath)
        ) {
          collected.push(relPath);
        }
        continue;
      }

      walk(fullPath, relPath);
    }
  };

  walk(appsDir, "");
  return collected.sort();
}

function resolveEntryPoint(appPath: string): string | null {
  const candidates = [
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/main.tsx",
    "index.ts",
    "index.tsx",
  ];

  for (const candidate of candidates) {
    if (existsSync(join(appPath, candidate))) {
      return candidate;
    }
  }

  return null;
}

function hasDevScript(appPath: string): boolean {
  const packageJsonPath = join(appPath, "package.json");
  if (!existsSync(packageJsonPath)) return false;

  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const packageJson = JSON.parse(raw) as { scripts?: { dev?: string } };
    return Boolean(packageJson.scripts?.dev);
  } catch {
    return false;
  }
}

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${COLORS.cyan}${question}${COLORS.reset}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectApp(apps: string[]): Promise<string> {
  log("\n📋 Available apps:", "cyan");
  apps.forEach((app, index) => {
    log(`  ${index + 1}. ${app}`, "yellow");
  });

  const answer = await promptUser(`\nSelect app (1-${apps.length}): `);
  const selectedIndex = parseInt(answer, 10) - 1;

  if (selectedIndex >= 0 && selectedIndex < apps.length) {
    return apps[selectedIndex];
  }

  log("Invalid app selection", "red");
  process.exit(1);
}

async function selectMode(): Promise<Mode> {
  log("\n⚙️ Mode:", "cyan");
  log("  1. dev", "yellow");
  log("  2. render", "yellow");

  const answer = await promptUser("\nSelect mode (1-2): ");
  if (answer === "1") return "dev";
  if (answer === "2") return "render";

  log("Invalid mode selection", "red");
  process.exit(1);
}

function getPnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runCommand(args: string[], cwd: string): void {
  const command = getPnpmCommand();
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    log(`✗ Command failed to start: ${result.error.message}`, "red");
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

async function main() {
  const apps = getAvailableApps();
  if (apps.length === 0) {
    log("No apps found in the apps/ directory", "red");
    log("Create an app using: pnpm create:project", "yellow");
    process.exit(1);
  }

  const appName = await selectApp(apps);
  const mode = await selectMode();
  const appPath = join(process.cwd(), "apps", appName);

  log(`\n🚀 Launching ${mode} for ${appName}...`, "blue");

  if (mode === "dev") {
    if (!hasDevScript(appPath)) {
      log(`App "${appName}" does not have a dev script`, "red");
      process.exit(1);
    }
    runCommand(["run", "dev"], appPath);
    return;
  }

  runCommand(["render", "--app", appName], process.cwd());
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  log("\n🛠️ Forge Launcher", "blue");
  log("\nUsage: pnpm forge launch", "cyan");
  log("\nFlow:", "cyan");
  log("  1. Select app by number", "yellow");
  log("  2. Select mode (dev or render)", "yellow");
  log("  3. Runs immediately", "yellow");
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  log(`Error: ${message}`, "red");
  process.exit(1);
});
