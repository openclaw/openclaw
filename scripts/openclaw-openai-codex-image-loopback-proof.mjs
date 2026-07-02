#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  "pnpm",
  [
    "test",
    "extensions/openai/image-generation-provider.loopback.test.ts",
    "--",
    "--reporter=verbose",
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_EMIT_LOOPBACK_PROOF: "1",
    },
    encoding: "utf8",
    shell: process.platform === "win32",
  },
);

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const jsonStart = stdout.indexOf("{");
const jsonEnd = stdout.lastIndexOf("}");

if (jsonStart >= 0 && jsonEnd > jsonStart) {
  process.stdout.write(`${stdout.slice(jsonStart, jsonEnd + 1)}\n`);
} else {
  process.stderr.write(stderr);
  process.stdout.write(stdout);
}

process.exit(result.status ?? 1);
