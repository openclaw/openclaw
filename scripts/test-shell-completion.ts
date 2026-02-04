/**
 * Test script for shell completion installation feature.
 *
 * This script simulates the shell completion prompt that appears during
 * `openclaw update`. Use it to verify the completion installation flow
 * without running a full update.
 *
 * Run from repo root:
 *   node --import tsx scripts/test-shell-completion.ts [options]
 *   npx tsx scripts/test-shell-completion.ts [options]
 *   bun scripts/test-shell-completion.ts [options]
 *
 * Options:
 *   --shell <shell>   Override shell detection (zsh, bash, fish, powershell)
 *   --check-only      Only check status, don't prompt to install
 *   --force           Skip the "already installed" check and prompt anyway
 *   --help            Show this help message
 *
 * Examples:
 *   node --import tsx scripts/test-shell-completion.ts
 *   node --import tsx scripts/test-shell-completion.ts --check-only
 *   node --import tsx scripts/test-shell-completion.ts --shell bash
 *   node --import tsx scripts/test-shell-completion.ts --force
 */

import { confirm, isCancel } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installCompletion,
  isCompletionInstalled,
  resolveShellFromEnv,
} from "../src/cli/completion-cli.js";
import { resolveStateDir } from "../src/config/paths.js";
import { stylePromptMessage } from "../src/terminal/prompt-style.js";
import { theme } from "../src/terminal/theme.js";

const CLI_NAME = "openclaw";
const SUPPORTED_SHELLS = ["zsh", "bash", "fish", "powershell"] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

interface Options {
  shell?: string;
  checkOnly: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    checkOnly: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--shell" && args[i + 1]) {
      options.shell = args[i + 1];
      i++;
    } else if (arg === "--check-only") {
      options.checkOnly = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
${theme.heading("Shell Completion Test Script")}

This script simulates the shell completion prompt that appears during
\`openclaw update\`. Use it to verify the completion installation flow
without running a full update.

${theme.heading("Usage (run from repo root):")}
  node --import tsx scripts/test-shell-completion.ts [options]
  npx tsx scripts/test-shell-completion.ts [options]
  bun scripts/test-shell-completion.ts [options]

${theme.heading("Options:")}
  --shell <shell>   Override shell detection (zsh, bash, fish, powershell)
  --check-only      Only check status, don't prompt to install
  --force           Skip the "already installed" check and prompt anyway
  --help, -h        Show this help message

${theme.heading("Examples:")}
  node --import tsx scripts/test-shell-completion.ts
  node --import tsx scripts/test-shell-completion.ts --check-only
  node --import tsx scripts/test-shell-completion.ts --shell bash
  node --import tsx scripts/test-shell-completion.ts --force
`);
}

function isSupportedShell(shell: string): shell is SupportedShell {
  return SUPPORTED_SHELLS.includes(shell as SupportedShell);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveCompletionCacheExtension(shell: SupportedShell): string {
  switch (shell) {
    case "powershell":
      return "ps1";
    case "fish":
      return "fish";
    case "bash":
      return "bash";
    default:
      return "zsh";
  }
}

async function ensureCompletionCache(shell: SupportedShell): Promise<boolean> {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const cacheDir = path.join(stateDir, "completions");
  const ext = resolveCompletionCacheExtension(shell);
  const cachePath = path.join(cacheDir, `${CLI_NAME}.${ext}`);

  if (await pathExists(cachePath)) {
    console.log(`  Completion cache: ${theme.success("exists")} ${theme.muted(`(${cachePath})`)}`);
    return true;
  }

  console.log(`  Completion cache: ${theme.warn("missing")}`);
  console.log(theme.muted("  Generating completion cache..."));

  // Use the CLI to generate the cache (same approach as tryWriteCompletionCache in update-cli.ts)
  const binPath = path.join(process.cwd(), "openclaw.mjs");
  if (!(await pathExists(binPath))) {
    console.log(theme.error(`  Cannot find ${binPath}. Run from the repo root.`));
    return false;
  }

  // Use the same runtime as the CLI
  const runtime = process.execPath;
  const result = spawnSync(runtime, [binPath, "completion", "--write-state"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf-8",
    // Windows needs shell: true for proper execution in some cases
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.log(theme.error(`  Failed to generate cache: ${String(result.error)}`));
    return false;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    console.log(
      theme.error(
        `  Failed to generate cache (exit ${result.status})${stderr ? `: ${stderr}` : ""}`,
      ),
    );
    return false;
  }

  console.log(theme.success("  Completion cache generated."));
  return true;
}

function getShellProfilePath(shell: SupportedShell): string {
  const home = process.env.HOME || os.homedir();

  switch (shell) {
    case "zsh":
      return path.join(home, ".zshrc");
    case "bash":
      // Linux typically uses .bashrc, macOS uses .bash_profile
      return process.platform === "darwin"
        ? path.join(home, ".bash_profile")
        : path.join(home, ".bashrc");
    case "fish":
      return path.join(home, ".config", "fish", "config.fish");
    case "powershell":
      // PowerShell profile location varies by platform
      if (process.platform === "win32") {
        return path.join(
          process.env.USERPROFILE || home,
          "Documents",
          "PowerShell",
          "Microsoft.PowerShell_profile.ps1",
        );
      }
      return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  console.log(theme.heading("Shell Completion Test"));
  console.log("");

  // Determine shell
  let shell: SupportedShell;
  if (options.shell) {
    if (!isSupportedShell(options.shell)) {
      console.log(theme.error(`Unsupported shell: ${options.shell}`));
      console.log(theme.muted(`Supported shells: ${SUPPORTED_SHELLS.join(", ")}`));
      process.exit(1);
    }
    shell = options.shell;
    console.log(`  Shell: ${theme.accent(shell)} ${theme.muted("(override)")}`);
  } else {
    shell = resolveShellFromEnv() as SupportedShell;
    console.log(`  Shell: ${theme.accent(shell)} ${theme.muted("(detected from $SHELL)")}`);
  }

  // Show platform info
  console.log(`  Platform: ${theme.muted(process.platform)} ${theme.muted(`(${os.release()})`)}`);
  console.log(`  Profile: ${theme.muted(getShellProfilePath(shell))}`);
  console.log("");

  // Ensure completion cache exists
  const cacheOk = await ensureCompletionCache(shell);
  if (!cacheOk) {
    console.log(theme.warn("  Continuing without cache (will use dynamic completion)..."));
  }

  // Check if completion is installed in shell profile
  const installed = await isCompletionInstalled(shell, CLI_NAME);
  console.log(`  Profile configured: ${installed ? theme.success("yes") : theme.warn("no")}`);
  console.log("");

  if (options.checkOnly) {
    console.log(theme.muted("Check-only mode, exiting."));
    return;
  }

  if (installed && !options.force) {
    console.log(theme.muted("Shell completion is already installed. To test the prompt:"));
    console.log(
      theme.muted("  1. Remove the '# OpenClaw Completion' block from your shell profile"),
    );
    console.log(theme.muted("  2. Re-run this script"));
    console.log(theme.muted("  Or use --force to prompt anyway"));
    console.log("");
    return;
  }

  // Simulate the prompt from update-cli.ts
  console.log(theme.heading("Shell completion"));

  const shouldInstall = await confirm({
    message: stylePromptMessage(`Enable ${shell} shell completion for ${CLI_NAME}?`),
    initialValue: true,
  });

  if (isCancel(shouldInstall) || !shouldInstall) {
    console.log(theme.muted(`Skipped. Run \`openclaw completion --install\` later to enable.`));
    return;
  }

  // Install completion
  await installCompletion(shell, false, CLI_NAME);
}

main().catch((err) => {
  console.error(theme.error(`Error: ${String(err)}`));
  process.exit(1);
});
