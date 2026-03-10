// scripts/setup-hooks.mjs
import { execSync } from "node:child_process";

try {
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
  execSync("git config core.hooksPath git-hooks", { stdio: "ignore" });
  console.log("✅ Git hooks configured successfully.");
} catch (err) {
  // Expected failures: git not installed, or not inside a git work tree
  // (e.g., ZIP download). Exit gracefully so `pnpm install` isn't blocked.
  if (process.env.CI) {
    // Surface unexpected errors in CI so they aren't silently ignored.
    console.warn("⚠️  Git hooks setup skipped:", err.message);
  }
  process.exit(0);
}
