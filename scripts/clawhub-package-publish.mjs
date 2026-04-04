#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  if (existsSync(maybePath)) {
    return maybePath;
  }
  return path.join(repoRoot, "extensions", input);
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

if (!existsSync(pluginDir)) {
  fail(`Plugin directory not found: ${pluginDir}`);
}
if (!existsSync(path.join(pluginDir, "package.json"))) {
  fail(`Missing package.json in ${pluginDir}`);
}
if (!existsSync(path.join(pluginDir, "openclaw.plugin.json"))) {
  fail(`Missing openclaw.plugin.json in ${pluginDir}`);
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
];

if (!options.publish) {
  command.push("--dry-run");
}
if (options.json) {
  command.push("--json");
}
if (options.owner) {
  command.push("--owner", options.owner);
}
if (options.tags) {
  command.push("--tags", options.tags);
}
if (options.version) {
  command.push("--version", options.version);
}

if (!options.json) {
  console.log(`ClawHub source remote: ${remoteName} -> ${sourceRepo}`);
  console.log(`ClawHub source path: ${sourcePath}`);
  console.log(`ClawHub source ref: ${sourceRef}`);
  console.log(`Mode: ${options.publish ? "publish" : "dry-run"}`);
}

const result = spawnSync("npx", command, {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
