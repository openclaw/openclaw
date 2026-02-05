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
import os from "node:os";
import path from "node:path";
import { installCompletion } from "../src/cli/completion-cli.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../src/commands/doctor-completion.js";
import { stylePromptMessage } from "../src/terminal/prompt-style.js";
import { theme } from "../src/terminal/theme.js";

const CLI_NAME = "openclaw";

const writeStdout = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const writeStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface Options {
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

  for (const arg of args) {
    if (arg === "--check-only") {
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
  writeStdout(`
${theme.heading("Shell Completion Test Script")}

This script simulates the shell completion checks that run during
\`openclaw update\`, \`openclaw doctor\`, and \`openclaw onboard\`.

${theme.heading("Usage (run from repo root):")}
  node --import tsx scripts/test-shell-completion.ts [options]
  npx tsx scripts/test-shell-completion.ts [options]
  bun scripts/test-shell-completion.ts [options]

${theme.heading("Options:")}
  --check-only      Only check status, don't prompt to install
  --force           Skip the "already installed" check and prompt anyway
  --help, -h        Show this help message

${theme.heading("Behavior:")}
  - If profile has completion but no cache: auto-regenerates cache
  - If no completion at all: prompts to install
  - If both profile and cache exist: nothing to do

${theme.heading("Examples:")}
  node --import tsx scripts/test-shell-completion.ts
  node --import tsx scripts/test-shell-completion.ts --check-only
  node --import tsx scripts/test-shell-completion.ts --force
`);
}

function getShellProfilePath(shell: string): string {
  const home = process.env.HOME || os.homedir();

  switch (shell) {
    case "zsh":
      return path.join(home, ".zshrc");
    case "bash":
      return process.platform === "darwin"
        ? path.join(home, ".bash_profile")
        : path.join(home, ".bashrc");
    case "fish":
      return path.join(home, ".config", "fish", "config.fish");
    case "powershell":
      if (process.platform === "win32") {
        return path.join(
          process.env.USERPROFILE || home,
          "Documents",
          "PowerShell",
          "Microsoft.PowerShell_profile.ps1",
        );
      }
      return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
    default:
      return path.join(home, ".zshrc");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  writeStdout(theme.heading("Shell Completion Test"));
  writeStdout("");

  // Get completion status using the same function used by doctor/update/onboard
  const status = await checkShellCompletionStatus(CLI_NAME);

  writeStdout(`  Shell: ${theme.accent(status.shell)} ${theme.muted("(detected from $SHELL)")}`);
  writeStdout(`  Platform: ${theme.muted(process.platform)} ${theme.muted(`(${os.release()})`)}`);
  writeStdout(`  Profile: ${theme.muted(getShellProfilePath(status.shell))}`);
  writeStdout(`  Cache path: ${theme.muted(status.cachePath)}`);
  writeStdout("");
  writeStdout(
    `  Profile configured: ${status.profileInstalled ? theme.success("yes") : theme.warn("no")}`,
  );
  writeStdout(`  Cache exists: ${status.cacheExists ? theme.success("yes") : theme.warn("no")}`);
  writeStdout(
    `  Uses slow pattern: ${status.usesSlowPattern ? theme.error("yes (needs upgrade)") : theme.success("no")}`,
  );
  writeStdout("");

  if (options.checkOnly) {
    writeStdout(theme.muted("Check-only mode, exiting."));
    return;
  }

  // Profile uses slow dynamic pattern - upgrade to cached version
  if (status.usesSlowPattern) {
    writeStdout(theme.warn("Profile uses slow dynamic completion. Upgrading to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, false, CLI_NAME);
      writeStdout(theme.success("Upgraded to cached completion."));
    } else {
      writeStdout(theme.error("Failed to generate cache."));
    }
    return;
  }

  // Profile has completion but no cache - auto-fix
  if (status.profileInstalled && !status.cacheExists) {
    writeStdout(theme.warn("Profile has completion but cache is missing. Regenerating..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      writeStdout(theme.success("Cache regenerated successfully."));
    } else {
      writeStdout(theme.error("Failed to regenerate cache."));
    }
    return;
  }

  // Both profile and cache exist - nothing to do
  if (status.profileInstalled && status.cacheExists && !options.force) {
    writeStdout(theme.muted("Shell completion is fully configured. To test the prompt:"));
    writeStdout(
      theme.muted("  1. Remove the '# OpenClaw Completion' block from your shell profile"),
    );
    writeStdout(theme.muted("  2. Re-run this script"));
    writeStdout(theme.muted("  Or use --force to prompt anyway"));
    writeStdout("");
    return;
  }

  // No profile configured - prompt to install
  writeStdout(theme.heading("Shell completion"));

  const shouldInstall = await confirm({
    message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
    initialValue: true,
  });

  if (isCancel(shouldInstall) || !shouldInstall) {
    writeStdout(theme.muted(`Skipped. Run \`openclaw completion --install\` later to enable.`));
    return;
  }

  // Generate cache first (required for fast shell startup)
  if (!status.cacheExists) {
    writeStdout(theme.muted("Generating completion cache..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      writeStdout(theme.error("Failed to generate completion cache."));
      return;
    }
    writeStdout(theme.success("Cache generated."));
  }

  // Install to shell profile
  await installCompletion(status.shell, false, CLI_NAME);
}

main().catch((err) => {
  writeStderr(theme.error(`Error: ${String(err)}`));
  process.exit(1);
});
