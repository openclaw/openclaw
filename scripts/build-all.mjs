#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const nodeBin = process.execPath;
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const steps = [
  { cmd: pnpmBin, args: ["canvas:a2ui:bundle"] },
  { cmd: nodeBin, args: ["scripts/tsdown-build.mjs"] },
  { cmd: nodeBin, args: ["scripts/runtime-postbuild.mjs"] },
  { cmd: nodeBin, args: ["scripts/build-stamp.mjs"] },
  { cmd: pnpmBin, args: ["build:plugin-sdk:dts"] },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/write-plugin-sdk-entry-dts.ts"] },
  { cmd: nodeBin, args: ["scripts/check-plugin-sdk-exports.mjs"] },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/canvas-a2ui-copy.ts"] },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/copy-hook-metadata.ts"] },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/copy-export-html-templates.ts"] },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/write-build-info.ts"] },
  {
    cmd: nodeBin,
    args: ["--experimental-strip-types", "scripts/write-cli-startup-metadata.ts"],
  },
  { cmd: nodeBin, args: ["--import", "tsx", "scripts/write-cli-compat.ts"] },
];

for (const step of steps) {
  const result = spawnSync(step.cmd, step.args, {
    stdio: "inherit",
    env: process.env,
  });
  if (typeof result.status === "number") {
    if (result.status !== 0) {
      process.exit(result.status);
    }
    continue;
  }
  process.exit(1);
}
