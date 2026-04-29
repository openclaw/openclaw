#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jscpdBin = path.join(repoRoot, "node_modules", "jscpd", "bin", "jscpd");

const targets = [
  "src",
  "extensions",
  "scripts",
  "packages",
  "ui",
  "apps",
  "qa",
  "test",
  "openclaw.mjs",
  "knip.config.ts",
  "tsdown.config.ts",
  "vitest.config.ts",
];

const generatedIgnores = [
  "extensions/qa-matrix/src/shared/**",
  "extensions/qa-matrix/src/report.ts",
  "extensions/qa-matrix/src/docker-runtime.ts",
  "extensions/qa-matrix/src/cli-paths.ts",
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
  "**/build/**",
  "**/.build/**",
  "**/.artifacts/**",
  "vendor/**",
];

const testIgnores = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.e2e.test.ts",
  "**/*.live.test.ts",
];

const commonArgs = [
  "--format",
  "typescript,javascript",
  "--gitignore",
  "--noSymlinks",
  "--min-lines",
  "50",
  "--min-tokens",
  "300",
];

const json = process.argv.includes("--json");

function reportArgs(name) {
  if (!json) {
    return ["--reporters", "console"];
  }
  return ["--reporters", "json", "--output", path.join(".artifacts", "jscpd", name)];
}

const scans = [
  {
    name: "production",
    pattern: "**/*.{ts,tsx,js,mjs,cjs}",
    ignore: [...testIgnores, ...generatedIgnores],
  },
  {
    name: "tests",
    pattern: "**/*.{test,e2e.test,live.test}.{ts,tsx,js}",
    ignore: generatedIgnores,
  },
];

let failed = false;
for (const scan of scans) {
  console.log(`\n[dup:check] ${scan.name}`);
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      jscpdBin,
      ...targets,
      ...commonArgs,
      "--pattern",
      scan.pattern,
      "--ignore",
      scan.ignore.join(","),
      ...reportArgs(scan.name),
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    failed = true;
  }
  if (result.error) {
    console.error(result.error.message);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
