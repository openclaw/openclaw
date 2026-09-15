#!/usr/bin/env node
// Real-behavior proof for managed Gateway launcher drain (#146956 / PR #147054).
// Current product path: packaged compile-cache respawn + 328s Gateway grace.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string[]} args
 * @param {string} label
 * @param {{ skipOnWin32?: boolean }} [options]
 */
function runVitest(args, label, options = {}) {
  if (options.skipOnWin32 && process.platform === "win32") {
    console.log(`${label}: skipped on win32 (SIGTERM child timing differs)`);
    return;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "run-vitest.mjs"), "run", ...args, "--reporter=verbose"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "600000" },
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "unknown"}`);
  }
  console.log(`${label}: passed`);
}

function main() {
  runVitest(
    ["src/infra/node-runtime-recovery.test.ts", "-t", "runtime recovery child shutdown"],
    "unit recovery shutdown proof",
  );
  runVitest(
    ["src/infra/node-runtime-recovery.gateway-drain.test.ts"],
    "recovery child real-request grace proof",
    { skipOnWin32: true },
  );
  runVitest(
    [
      "test/openclaw-launcher.e2e.test.ts",
      "-t",
      "preserves foreground Gateway shutdown grace with packaged compile cache",
    ],
    "packaged launcher proof",
    { skipOnWin32: true },
  );
  console.log("All gateway launcher drain proof checks passed.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
}
