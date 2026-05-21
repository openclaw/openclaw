#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHRINKWRAP_PATH = path.join(ROOT_DIR, "npm-shrinkwrap.json");

function usage() {
  return "Usage: node scripts/generate-npm-shrinkwrap.mjs [--check]";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function normalizeOverrideValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOverrideValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeOverrideValue(nestedValue)]),
    );
  }
  return String(value);
}

function normalizeOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  return normalizeOverrideValue(overrides);
}

function readWorkspaceOverrides() {
  const workspace = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-workspace.yaml"), "utf8"));
  return normalizeOverrides(workspace?.overrides);
}

function mergeOverrides(packageOverrides, workspaceOverrides) {
  const merged = normalizeOverrides(packageOverrides);
  for (const [name, spec] of Object.entries(workspaceOverrides)) {
    const current = merged[name];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(spec)) {
      throw new Error(
        `package.json overrides.${name} conflicts with pnpm-workspace.yaml overrides.${name}`,
      );
    }
    merged[name] = spec;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function packageJsonForShrinkwrap(packageJson) {
  const normalized = { ...packageJson };
  delete normalized.devDependencies;
  normalized.overrides = mergeOverrides(packageJson.overrides, readWorkspaceOverrides());
  return normalized;
}

function runNpm(args, cwd) {
  execFileSync(npmCommand(), args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function generateShrinkwrap() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-shrinkwrap-"));
  try {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    writeFileSync(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(packageJsonForShrinkwrap(packageJson), null, 2)}\n`,
    );
    runNpm(
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      tempDir,
    );
    runNpm(["shrinkwrap", "--ignore-scripts", "--no-audit", "--no-fund"], tempDir);
    return readFileSync(path.join(tempDir, "npm-shrinkwrap.json"), "utf8");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  if (args.some((arg) => arg !== "--check")) {
    throw new Error(usage());
  }

  const generated = generateShrinkwrap();
  if (!check) {
    writeFileSync(SHRINKWRAP_PATH, generated);
    process.stdout.write("npm-shrinkwrap.json updated.\n");
    return;
  }

  let current = "";
  try {
    current = readFileSync(SHRINKWRAP_PATH, "utf8");
  } catch {
    throw new Error("npm-shrinkwrap.json is missing. Run `pnpm deps:shrinkwrap:generate`.");
  }
  if (current !== generated) {
    throw new Error("npm-shrinkwrap.json is stale. Run `pnpm deps:shrinkwrap:generate`.");
  }
  process.stdout.write("npm-shrinkwrap.json is current.\n");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
