#!/usr/bin/env node
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";

await runNodeCliShim(import.meta.url, {
  implementation: "./watch-pr-ci.mts",
  // Native PR supervision owns this pipe; the metadata helper forwards it to gh.
  // Inheriting only stdin/stdout/stderr would leave its environment flag dangling.
  stdio:
    process.env.OPENCLAW_PR_LOCK_NOTIFY_FD === "3"
      ? ["inherit", "inherit", "inherit", 3]
      : "inherit",
});
