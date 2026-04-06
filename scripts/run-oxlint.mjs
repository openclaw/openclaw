import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
} from "./lib/local-heavy-check-runtime.mjs";

const EXTENSION_ALLOWLIST_PATH = path.resolve(".oxlint-extension-allowlist.json");
const FLAGS_WITH_VALUES = new Set([
  "--config",
  "-c",
  "--format",
  "--ignore-pattern",
  "--threads",
  "-t",
  "--tsconfig",
  "-p",
]);

const rawArgs = process.argv.slice(2);
const allowlistedArgs = applyDefaultExtensionAllowlist(rawArgs);
const { args: finalArgs, env } = applyLocalOxlintPolicy(allowlistedArgs, process.env);

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env,
  toolName: "oxlint",
});

try {
  const result = spawnSync(oxlintPath, finalArgs, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} finally {
  releaseLock();
}

function applyDefaultExtensionAllowlist(args) {
  if (hasExplicitTargets(args)) {
    return [...args];
  }

  const allowlistedExtensions = loadAllowlistedExtensions();
  if (allowlistedExtensions.size === 0) {
    return [...args];
  }

  const nextArgs = [...args];
  for (const extensionDir of listExtensionDirs()) {
    if (allowlistedExtensions.has(extensionDir)) {
      continue;
    }
    insertBeforeSeparator(nextArgs, "--ignore-pattern", `${extensionDir}/**`);
  }
  return nextArgs;
}

function hasExplicitTargets(args) {
  let expectsValue = false;
  for (const arg of args) {
    if (expectsValue) {
      expectsValue = false;
      continue;
    }

    if (arg === "--") {
      continue;
    }

    const [flag] = arg.split("=", 1);
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && FLAGS_WITH_VALUES.has(flag)) {
        expectsValue = true;
      }
      continue;
    }

    return true;
  }

  return false;
}

function loadAllowlistedExtensions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EXTENSION_ALLOWLIST_PATH, "utf8"));
    const configured = Array.isArray(parsed?.extensions) ? parsed.extensions : [];
    return new Set(
      configured
        .filter((value) => typeof value === "string")
        .map((value) => value.replaceAll(path.sep, "/")),
    );
  } catch {
    return new Set();
  }
}

function listExtensionDirs() {
  const extensionsDir = path.resolve("extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("extensions", entry.name))
    .toSorted();
}

function insertBeforeSeparator(args, ...items) {
  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}
