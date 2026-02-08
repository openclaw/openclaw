#!/usr/bin/env node
/**
 * Runtime detection for openclaw.
 * Returns 'bun' if OPENCLAW_RUNTIME=bun, otherwise 'node'.
 * Used by scripts to determine which runtime to use.
 */

const runtime = process.env.OPENCLAW_RUNTIME === "bun" ? "bun" : "node";

// If called directly, print the runtime
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(runtime);
}

export { runtime };
export default runtime;
