// scripts/setup-hooks.mjs
import { execSync } from "node:child_process";

try {
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
  execSync("git config core.hooksPath git-hooks", { stdio: "ignore" });
  console.log("✅ Git hooks configured successfully.");
} catch (error) {
  console.warn(
    "⚠️ Note: Git hooks were not configured (expected if you downloaded a ZIP or are not in a git repository).",
  );
  console.warn(`   Details: ${error.message}`);

  process.exit(0);
}
