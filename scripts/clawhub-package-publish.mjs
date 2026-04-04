#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function runGit(cwd, args, required = true) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (!required) {
    return "";
  }
  fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
}

function normalizeGitHubRepo(remoteUrl) {
  const trimmed = remoteUrl
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/i, "")
    .replace(/^git@github\.com:/i, "https://github.com/");
  if (!trimmed) {
    return "";
  }

  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shorthand) {
    return `${shorthand[1]}/${shorthand[2]}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (!/^github\.com$/i.test(parsed.hostname) && !/^www\.github\.com$/i.test(parsed.hostname)) {
      return "";
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return "";
    }
    return `${segments[0]}/${segments[1].replace(/\.git$/i, "")}`;
  } catch {
    return "";
  }
}

function resolvePluginDir(repoRoot, input) {
  const maybePath = path.resolve(process.cwd(), input);
  if (fs.existsSync(maybePath)) {
    return maybePath;
  }
  return path.join(repoRoot, "extensions", input);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  let source = pattern.startsWith("/") ? "^" : "(^|/)";

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    const nextNext = trimmed[index + 2];

    if (char === "*" && next === "*" && nextNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

function loadIgnoreMatchers(pluginDir) {
  const matchers = [];
  for (const fileName of [".clawhubignore", ".clawdhubignore"]) {
    const filePath = path.join(pluginDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        continue;
      }
      matchers.push(globToRegExp(trimmed));
    }
  }
  return matchers;
}

function shouldIgnore(relPath, ignoreMatchers) {
  if (
    relPath.startsWith(".git/") ||
    relPath.startsWith("node_modules/") ||
    relPath.startsWith(".clawhub/") ||
    relPath.startsWith(".clawdhub/")
  ) {
    return true;
  }
  return ignoreMatchers.some((matcher) => matcher.test(relPath));
}

function listPackageFiles(pluginDir) {
  const files = [];
  const ignoreMatchers = loadIgnoreMatchers(pluginDir);

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = path.relative(pluginDir, absPath).split(path.sep).join("/");
      if (!relPath || shouldIgnore(relPath, ignoreMatchers)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        relPath,
        size: fs.statSync(absPath).size,
      });
    }
  }

  walk(pluginDir);
  return files;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isSemverLike(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function parseArgs(argv) {
  const options = {
    json: false,
    publish: false,
    remote: "",
    owner: "",
    tags: "",
    version: "",
    plugin: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--remote":
        options.remote = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--owner":
        options.owner = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--tags":
        options.tags = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--version":
        options.version = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        if (arg.startsWith("--")) {
          fail(`Unknown option: ${arg}`);
        }
        if (!options.plugin) {
          options.plugin = arg;
        } else {
          fail(`Unexpected extra argument: ${arg}`);
        }
    }
  }

  if (!options.plugin) {
    fail("Usage: node scripts/clawhub-package-publish.mjs <plugin-id|path> [--publish] [--json]");
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
const pluginDir = resolvePluginDir(repoRoot, options.plugin);

if (!fs.existsSync(pluginDir)) {
  fail(`Plugin directory not found: ${pluginDir}`);
}
if (!fs.existsSync(path.join(pluginDir, "package.json"))) {
  fail(`Missing package.json in ${pluginDir}`);
}
if (!fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))) {
  fail(`Missing openclaw.plugin.json in ${pluginDir}`);
}

const packageJson = readJson(path.join(pluginDir, "package.json"), "package.json");
const pluginManifest = readJson(
  path.join(pluginDir, "openclaw.plugin.json"),
  "openclaw.plugin.json",
);
const openclaw = packageJson && typeof packageJson === "object" ? (packageJson.openclaw ?? {}) : {};
const compat = openclaw && typeof openclaw === "object" ? (openclaw.compat ?? {}) : {};
const build = openclaw && typeof openclaw === "object" ? (openclaw.build ?? {}) : {};
const version = options.version || readTrimmedString(packageJson.version);
const name = readTrimmedString(packageJson.name) || readTrimmedString(pluginManifest.id);
const displayName =
  readTrimmedString(packageJson.displayName) ||
  readTrimmedString(pluginManifest.name) ||
  path.basename(pluginDir);

if (!name) {
  fail("Package name is missing.");
}
if (!displayName) {
  fail("Display name is missing.");
}
if (!version) {
  fail("Version is missing.");
}
if (!isSemverLike(version)) {
  fail(`Version must look like semver for ClawHub code plugins: ${version}`);
}
if (!readTrimmedString(compat.pluginApi)) {
  fail("package.json is missing openclaw.compat.pluginApi");
}
if (!readTrimmedString(build.openclawVersion)) {
  fail("package.json is missing openclaw.build.openclawVersion");
}

const remotes = runGit(repoRoot, ["remote"], false)
  .split(/\s+/)
  .map((value) => value.trim())
  .filter(Boolean);
const remoteName =
  options.remote ||
  (remotes.includes("fork") ? "fork" : remotes.includes("origin") ? "origin" : remotes[0] || "");
if (!remoteName) {
  fail("No git remote found. Add a GitHub remote or pass --remote.");
}

const sourceRepo = normalizeGitHubRepo(runGit(repoRoot, ["remote", "get-url", remoteName]));
if (!sourceRepo) {
  fail(`Remote "${remoteName}" is not a GitHub remote.`);
}

const sourceCommit = runGit(repoRoot, ["rev-parse", "HEAD"]);
const sourceRef =
  runGit(repoRoot, ["describe", "--tags", "--exact-match"], false) ||
  runGit(repoRoot, ["branch", "--show-current"], false) ||
  sourceCommit;
const sourcePath = path.relative(repoRoot, pluginDir).split(path.sep).join("/");
const files = listPackageFiles(pluginDir);
const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

if (files.length === 0) {
  fail(`No publishable files found in ${pluginDir}`);
}

const dryRunPlan = {
  source: `${sourceRepo}@${sourceRef}:${sourcePath}`,
  name,
  displayName,
  family: "code-plugin",
  version,
  commit: sourceCommit,
  files: files.length,
  totalBytes,
  compatibility: {
    pluginApiRange: readTrimmedString(compat.pluginApi),
    builtWithOpenClawVersion: readTrimmedString(build.openclawVersion),
    pluginSdkVersion: readTrimmedString(build.pluginSdkVersion),
    minGatewayVersion: readTrimmedString(compat.minGatewayVersion),
  },
};

if (!options.publish) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(dryRunPlan, null, 2)}\n`);
  } else {
    console.log(`ClawHub source remote: ${remoteName} -> ${sourceRepo}`);
    console.log(`ClawHub source path: ${sourcePath}`);
    console.log(`ClawHub source ref: ${sourceRef}`);
    console.log(`Name: ${name}`);
    console.log(`Display name: ${displayName}`);
    console.log(`Version: ${version}`);
    console.log(`Files: ${files.length}`);
    console.log(`Total bytes: ${totalBytes}`);
    console.log(
      `Compat: pluginApi=${dryRunPlan.compatibility.pluginApiRange}, builtWith=${dryRunPlan.compatibility.builtWithOpenClawVersion}, minGateway=${dryRunPlan.compatibility.minGatewayVersion || "-"}`,
    );
    console.log("Mode: dry-run (local preflight)");
  }
  process.exit(0);
}

const command = [
  "-y",
  "clawhub@0.9.0",
  "package",
  "publish",
  pluginDir,
  "--source-repo",
  sourceRepo,
  "--source-commit",
  sourceCommit,
  "--source-ref",
  sourceRef,
  "--source-path",
  sourcePath,
  "--version",
  version,
];

if (options.json) {
  command.push("--json");
}
if (options.owner) {
  command.push("--owner", options.owner);
}
if (options.tags) {
  command.push("--tags", options.tags);
}

if (!options.json) {
  console.log(`ClawHub source remote: ${remoteName} -> ${sourceRepo}`);
  console.log(`ClawHub source path: ${sourcePath}`);
  console.log(`ClawHub source ref: ${sourceRef}`);
  console.log("Mode: publish");
}

const result = spawnSync("npx", command, {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
