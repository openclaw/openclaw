#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) {
    return process.argv[i + 1];
  }

  return fallback;
}

const base = arg("--base");
const head = arg("--head", "HEAD");
if (!base) {
  console.error("Missing --base <sha>");
  process.exit(2);
}

const diff = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMRT", `${base}...${head}`],
  { encoding: "utf8" },
)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const blocked = [];
const binaryExt = /\.(tgz|zip|7z|rar|dmg|exe|msi|bin)$/i;
const distDir = /(?:^|\/)dist\//;
for (const p of diff) {
  if (binaryExt.test(p) || distDir.test(p)) {
    blocked.push(p);
  }
}

if (blocked.length > 0) {
  console.error("Blocked release/binary artifacts detected in PR diff:");
  for (const p of new Set(blocked)) {
    console.error(` - ${p}`);
  }

  console.error("Remove these artifacts from the PR (or split into release pipeline PR).");
  process.exit(1);
}

console.log("OK: no blocked binary/release artifacts in diff.");
