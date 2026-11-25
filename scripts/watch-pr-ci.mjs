#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { toolingDependencyOptions } from "./lib/tooling-dependencies.mjs";
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";

try {
  await runNodeCliShim(import.meta.url, {
    ...toolingDependencyOptions(fileURLToPath(new URL("..", import.meta.url)), "watch-pr-ci"),
    implementation: "./watch-pr-ci.mts",
    // Native PR supervision owns this pipe; the metadata helper forwards it to gh.
    // Inheriting only stdin/stdout/stderr would leave its environment flag dangling.
    stdio:
      process.env.OPENCLAW_PR_LOCK_NOTIFY_FD === "3"
        ? ["inherit", "inherit", "inherit", 3]
        : "inherit",
  });
} catch (error) {
  console.error(`[watch-pr-ci] ${error.message}`);
  process.exitCode = 1;
}
