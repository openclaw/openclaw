// scripts/setup-hooks.mjs
import { execSync } from "node:child_process";

try {
  // Step 1: Check if the current directory is inside a git work tree.
  // This verifies that Git is installed and handles cases where
  // the user might be running the installation from a subdirectory.
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });

  // Step 2: If the check passes, safely set the git hooks path
  // to the project's custom 'git-hooks' directory.
  execSync("git config core.hooksPath git-hooks", { stdio: "ignore" });

  console.log("✅ Git hooks configured successfully.");
} catch {
  // Silently catch all exceptions and exit with status code 0.
  // This ensures that if a user downloads the source code as a ZIP file
  // (without a .git directory) or doesn't have Git installed,
  // the 'pnpm install' process will continue without failing.
  process.exit(0);
}
