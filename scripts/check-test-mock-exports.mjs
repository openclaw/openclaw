#!/usr/bin/env node
import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./check-test-mock-exports.mts",
  toolingDependencies: "test-mock-exports",
  failureTool: "test-mock-exports",
});
