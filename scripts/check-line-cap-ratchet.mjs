#!/usr/bin/env node
import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./check-line-cap-ratchet.mts",
  toolingDependencies: "line-cap-ratchet",
  failureTool: "line-cap-ratchet",
});
