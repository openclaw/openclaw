import fs from "node:fs";
import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import { createVitestRunSpecs, writeVitestIncludeFile } from "./test-projects.test-support.mjs";

// Keep this shim so `pnpm test -- src/foo.test.ts` still forwards filters
// cleanly instead of leaking pnpm's passthrough sentinel to Vitest.
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env: process.env,
  toolName: "test",
});
let lockReleased = false;

const releaseLockOnce = () => {
  if (lockReleased) {
    return;
  }
  lockReleased = true;
  releaseLock();
};

function cleanupVitestRunSpec(spec) {
  if (!spec.includeFilePath) {
    return;
  }
  try {
    fs.rmSync(spec.includeFilePath, { force: true });
  } catch {
    // Best-effort cleanup for temp include lists.
  }
}

function runVitestSpec(spec) {
  if (spec.includeFilePath && spec.includePatterns) {
    writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
  }
  return new Promise((resolve, reject) => {
    const child = spawnPnpmRunner({
      pnpmArgs: spec.pnpmArgs,
      env: spec.env,
    });

    child.on("exit", (code, signal) => {
      cleanupVitestRunSpec(spec);
      resolve({ code: code ?? 1, signal });
    });

    child.on("error", (error) => {
      cleanupVitestRunSpec(spec);
      reject(error);
    });
  });
}

async function main() {
  const runSpecs = createVitestRunSpecs(process.argv.slice(2), {
    baseEnv: process.env,
    cwd: process.cwd(),
  });

  for (const spec of runSpecs) {
    const result = await runVitestSpec(spec);
    if (result.signal) {
      releaseLockOnce();
      process.kill(process.pid, result.signal);
      return;
    }
    if (result.code !== 0) {
      releaseLockOnce();
      process.exit(result.code);
    }
  }

  releaseLockOnce();
}

main().catch((error) => {
  releaseLockOnce();
  console.error(error);
  process.exit(1);
});
