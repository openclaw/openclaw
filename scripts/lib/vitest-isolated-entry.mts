// Executed only inside the admitted container, before any Vitest/build imports.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { runManagedCommand } from "./managed-child-process.mts";
import { resolveIsolatedVitestBuild } from "./vitest-isolated-build.mts";
import { prepareIsolatedVitestScratch } from "./vitest-isolated-source.mts";

const [nodeVersion, pnpmVersion, ...argv] = process.argv.slice(2);
if (process.version !== nodeVersion) {
  throw new Error("Isolated Node does not match the prepared host runtime.");
}
// Worktree allocation needs disk-backed capacity, not the bounded /tmp tmpfs.
// Snapshot removal owns this scratch after every container descendant has joined.
prepareIsolatedVitestScratch("/workspace");
fs.mkdirSync("/tmp/home", { recursive: true });
const pnpm = spawnSync("/opt/openclaw-vitest/pnpm", ["--version"], {
  encoding: "utf8",
  timeout: 30_000,
});
if (pnpm.status !== 0 || pnpm.stdout.trim() !== pnpmVersion) {
  throw new Error("Prepared native pnpm is incompatible with the image or packageManager pin.");
}
const require = createRequire("/workspace/package.json");
require.resolve("vitest/node");
require.resolve("tsx/esm");
const { chromium } = await import("playwright");
// Prove both the installed Playwright revision and its shared-library/runtime
// compatibility, offline, with the same non-root/capability restrictions.
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
await browser.close();
console.error(
  `[vitest:isolated] preflight Node ${process.version}, pnpm ${pnpmVersion}, Chromium OK`,
);
let exitCode = 0;
const build = resolveIsolatedVitestBuild(argv, process.env);
if (build) {
  // The admitted snapshot has no serving Gateway or generated artifacts. Build
  // its selected prerequisites before ordinary readers apply host admission.
  console.error(`[vitest:isolated] preparing ${build.profile} artifacts`);
  exitCode = await runManagedCommand({
    bin: process.execPath,
    args: ["--import", "./scripts/tsx.mjs", "scripts/build-all.mts", build.profile],
    cwd: "/workspace",
    env: {
      ...process.env,
      ...(build.privateQa ? { OPENCLAW_BUILD_PRIVATE_QA: "1" } : {}),
      ...(build.declarations ? { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" } : {}),
    },
    requireProcessTreeExit: true,
  });
}
if (exitCode === 0) {
  exitCode = await runManagedCommand({
    bin: process.execPath,
    args: ["scripts/run-vitest.mjs", ...argv],
    cwd: "/workspace",
    env: process.env,
    requireProcessTreeExit: true,
  });
}
process.exitCode = exitCode;
