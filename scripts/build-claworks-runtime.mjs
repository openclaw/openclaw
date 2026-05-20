#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages/claworks-runtime");
const tsdown = join(root, "node_modules/.bin/tsdown");

const entries = [
  "src/index.ts",
  "src/kernel/index.ts",
  "src/pack-loader/index.ts",
  "src/claworks/index.ts",
  "src/planes/data/index.ts",
  "src/planes/orch/index.ts",
  "src/interfaces/index.ts",
];

const result = spawnSync(
  tsdown,
  [
    ...entries,
    "--no-config",
    "--platform",
    "node",
    "--format",
    "esm",
    "--dts",
    "--out-dir",
    "dist",
    "--clean",
  ],
  { cwd: pkgDir, stdio: "inherit" },
);

process.exit(result.status ?? 1);
