#!/usr/bin/env node

/**
 * Prints the local-check resource mode for the current machine.
 *
 * Output (one of): "throttled" | "full"
 *
 * Used by the pre-commit hook to decide whether to throttle staged-file
 * checks and whether to skip the heavy changed-scope check gate.
 *
 * Mirrors the thresholds in scripts/lib/local-heavy-check-runtime.mjs
 * (shouldThrottleLocalHeavyChecks) so the hook and the runtime stay in sync.
 *
 * Keep this dependency-free (no pnpm imports) — it runs early in the hook.
 */

import os from "node:os";

const GIB = 1024 ** 3;
const MIN_MEMORY_BYTES = 48 * GIB;
const MIN_CPUS = 12;

const mode = process.env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();

if (mode === "throttled" || mode === "low-memory") {
  process.stdout.write("throttled");
  process.exit(0);
}

if (mode === "full" || mode === "fast") {
  process.stdout.write("full");
  process.exit(0);
}

const raw = process.env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
if (raw === "0" || raw === "false") {
  process.stdout.write("full");
  process.exit(0);
}

const totalMemory = os.totalmem();
const cpuCount =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

if (totalMemory < MIN_MEMORY_BYTES || cpuCount < MIN_CPUS) {
  process.stdout.write("throttled");
} else {
  process.stdout.write("full");
}
