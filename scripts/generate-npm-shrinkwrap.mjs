#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/generate-npm-shrinkwrap.mjs [--check] [--all|--plugins|--package-dir <dir>]",
    "  default: root package only",
  ].join("\n");
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

function generateShrinkwrap(packageDir) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-shrinkwrap-"));
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
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

function packageLabel(packageDir) {
  const relative = path.relative(ROOT_DIR, packageDir);
  return relative ? relative.replaceAll(path.sep, "/") : ".";
}

function shrinkwrapPathForPackage(packageDir) {
  return path.join(packageDir, "npm-shrinkwrap.json");
}

function listPublishablePluginPackageDirs() {
  const extensionsDir = path.join(ROOT_DIR, "extensions");
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("extensions", entry.name))
    .filter((packageDir) => {
      const packageJsonPath = path.join(ROOT_DIR, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return false;
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return packageJson.openclaw?.release?.publishToNpm === true;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function resolvePackageDirs(args) {
  const packageDirs = [];
  const check = args.includes("--check");
  const all = args.includes("--all");
  const plugins = args.includes("--plugins");
  const packageDirIndex = args.indexOf("--package-dir");
  if (packageDirIndex !== -1 && (all || plugins)) {
    throw new Error("--package-dir cannot be combined with --all or --plugins.");
  }
  if (all && plugins) {
    throw new Error("--all cannot be combined with --plugins.");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check" || arg === "--all" || arg === "--plugins") {
      continue;
    }
    if (arg === "--package-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--package-dir requires a package directory.");
      }
      packageDirs.push(path.resolve(ROOT_DIR, value));
      index += 1;
      continue;
    }
    throw new Error(usage());
  }

  if (all) {
    return {
      check,
      packageDirs: [
        ROOT_DIR,
        ...listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
      ],
    };
  }
  if (plugins) {
    return {
      check,
      packageDirs: listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
    };
  }
  return { check, packageDirs: packageDirs.length > 0 ? packageDirs : [ROOT_DIR] };
}

function updateOrCheckPackage(packageDir, check) {
  const generated = generateShrinkwrap(packageDir);
  const shrinkwrapPath = shrinkwrapPathForPackage(packageDir);
  const label = packageLabel(packageDir);
  if (!check) {
    writeFileSync(shrinkwrapPath, generated);
    process.stdout.write(`${label}: npm-shrinkwrap.json updated.\n`);
    return;
  }

  let current = "";
  try {
    current = readFileSync(shrinkwrapPath, "utf8");
  } catch {
    throw new Error(
      `${label}: npm-shrinkwrap.json is missing. Run \`pnpm deps:shrinkwrap:generate\`.`,
    );
  }
  if (current !== generated) {
    throw new Error(
      `${label}: npm-shrinkwrap.json is stale. Run \`pnpm deps:shrinkwrap:generate\`.`,
    );
  }
  process.stdout.write(`${label}: npm-shrinkwrap.json is current.\n`);
}

function main() {
  const { check, packageDirs } = resolvePackageDirs(process.argv.slice(2));
  for (const packageDir of packageDirs) {
    updateOrCheckPackage(packageDir, check);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
