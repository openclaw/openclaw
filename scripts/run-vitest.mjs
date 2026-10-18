#!/usr/bin/env node
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";

await runNodeCliShim(import.meta.url, {
  implementation: "./run-vitest-child.mts",
  failureTool: "test",
  failureExitCode: 2,
  terminationOwner: "implementation",
});
