#!/usr/bin/env tsx
/**
 * Start development server for an app or multiple apps
 */

import { spawn, ChildProcess } from "child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import * as readline from "readline";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function getAvailableApps(): string[] {
  const appsDir = join(process.cwd(), "apps");
  if (!existsSync(appsDir)) return [];

  return readdirSync(appsDir).filter((name) => {
    const fullPath = join(appsDir, name);
    return (
      statSync(fullPath).isDirectory() &&
      !name.startsWith("_") &&
      !name.includes("template") &&
      existsSync(join(fullPath, "package.json"))
    );
  });
}

function hasDevScript(appName: string): boolean {
  const appPath = join(process.cwd(), "apps", appName);
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

function startDevServer(appName: string, port?: number): ChildProcess {
  const appPath = join(process.cwd(), "apps", appName);

  log(`\n🚀 Starting dev server for ${appName}...`, "blue");

  const env = { ...process.env };
  if (port) {
    env.PORT = port.toString();
  }

  const devProcess = spawn("pnpm", ["run", "dev"], {
    cwd: appPath,
    stdio: "inherit",
    shell: true,
    env,
  });

  devProcess.on("error", (error) => {
    log(`✗ Failed to start ${appName}: ${error.message}`, "red");
  });

  return devProcess;
}

async function selectApp(availableApps: string[]): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  log("\n📋 Available apps:", "cyan");
  availableApps.forEach((app, index) => {
    log(`  ${index + 1}. ${app}`, "yellow");
  });

  return new Promise((resolve) => {
    rl.question(
      `\n${COLORS.cyan}Select app (1-${availableApps.length}): ${COLORS.reset}`,
      (answer) => {
        rl.close();
        const index = parseInt(answer, 10) - 1;
        if (index >= 0 && index < availableApps.length) {
          resolve(availableApps[index]);
        } else {
          log("Invalid selection", "red");
          process.exit(1);
        }
      },
    );
  });
}

async function main() {
  const args = process.argv.slice(2);
  const availableApps = getAvailableApps();

  if (availableApps.length === 0) {
    log("No apps found in the apps/ directory", "red");
    log("Create an app using: pnpm create:project", "yellow");
    process.exit(1);
  }

  let appName: string;

  if (args.length > 0) {
    // App specified as argument
    appName = args[0];
    if (!availableApps.includes(appName)) {
      log(`App "${appName}" not found`, "red");
      log("Available apps:", "yellow");
      availableApps.forEach((app) => log(`  - ${app}`, "yellow"));
      process.exit(1);
    }
  } else if (availableApps.length === 1) {
    // Only one app available
    appName = availableApps[0];
    log(`Starting the only available app: ${appName}`, "green");
  } else {
    // Multiple apps available, let user choose
    appName = await selectApp(availableApps);
  }

  if (!hasDevScript(appName)) {
    log(`App "${appName}" does not have a dev script`, "red");
    process.exit(1);
  }

  const port = args.includes("--port")
    ? parseInt(args[args.indexOf("--port") + 1], 10)
    : undefined;

  const devProcess = startDevServer(appName, port);

  // Handle termination
  process.on("SIGINT", () => {
    log("\n\n🛑 Stopping dev server...", "yellow");
    devProcess.kill("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    devProcess.kill("SIGTERM");
    process.exit(0);
  });
}

main().catch((error) => {
  log(`Error: ${error.message}`, "red");
  process.exit(1);
});
