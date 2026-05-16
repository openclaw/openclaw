#!/usr/bin/env node
/**
 * Live repro for packaged launcher compile-cache respawn guard (#82688).
 * Run: pnpm exec tsx scripts/repro/compile-cache-root-comparison-live-proof.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compile-cache-proof-"));
const scopedCacheDirectory = path.join(cacheRoot, "openclaw", "unknown", "no-package-json");
const launcher = path.join(repoRoot, "openclaw.mjs");

const probeEntry = `
import module from "node:module";
const current = module.getCompileCacheDir?.() ?? "cache:disabled";
process.stdout.write(
  JSON.stringify({
    current,
    respawn: process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED ?? "0",
  }),
);
`;

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-launcher-proof-"));
fs.mkdirSync(path.join(fixtureRoot, "dist"), { recursive: true });
fs.copyFileSync(launcher, path.join(fixtureRoot, "openclaw.mjs"));
fs.writeFileSync(path.join(fixtureRoot, "dist", "entry.js"), probeEntry, "utf8");

function runLauncher(label) {
  const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
    cwd: fixtureRoot,
    env: { ...process.env, NODE_COMPILE_CACHE: scopedCacheDirectory },
    encoding: "utf8",
  });
  const payload = JSON.parse((result.stdout || "{}").trim() || "{}");
  console.log(
    `${label}: exit=${result.status} respawn=${payload.respawn} current=${payload.current}`,
  );
  return payload;
}

console.log("NODE_COMPILE_CACHE (scoped)=", scopedCacheDirectory);
const first = runLauncher("first invoke");
const second = runLauncher("second invoke");
const nestedUnderScoped =
  typeof first.current === "string" &&
  first.current.includes(path.join("openclaw", "unknown", "no-package-json"));
console.log("active cache nested under scoped directory:", nestedUnderScoped);
console.log("no repeat respawn:", first.respawn === "0" && second.respawn === "0");
