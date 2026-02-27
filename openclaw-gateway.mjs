#!/usr/bin/env node

// Dedicated gateway entrypoint for shim launchers where invocation name
// is not preserved in process.argv.
if (process.argv[2] !== "gateway") {
  process.argv.splice(2, 0, "gateway");
}

await import("./openclaw.mjs");
