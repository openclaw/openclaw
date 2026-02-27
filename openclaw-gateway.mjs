#!/usr/bin/env node

// Keep this wrapper side-effect free. The gateway subcommand rewrite happens in
// run-main after entry-level profile parsing.
await import("./openclaw.mjs");
