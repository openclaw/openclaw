#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";
import { watchPrCiDependencyOptions } from "./lib/watch-pr-ci-dependencies.mjs";

try {
  await runNodeCliShim(import.meta.url, {
    ...watchPrCiDependencyOptions(fileURLToPath(new URL("..", import.meta.url))),
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
