#!/usr/bin/env node
// Synchronizes published stable package metadata onto a current main checkout.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const SYNC_COMMANDS = [
  { name: "release metadata", args: ["release:prep"] },
  { name: "npm shrinkwrap generation", args: ["deps:shrinkwrap:generate"] },
  { name: "npm shrinkwrap verification", args: ["deps:shrinkwrap:check"] },
];

export function parseArgs(argv) {
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!tag) {
    throw new Error("Usage: node scripts/sync-main-release-version.mjs --tag <stable-release-tag>");
  }
  return { tag };
}

export function planMainReleaseVersionSync({ tag, currentVersion, releasePackageVersion }) {
  const parsedTag = parseStableReleaseTag(tag);
  const expectedPackageVersions = new Set([parsedTag.baseVersion, parsedTag.version]);
  if (!expectedPackageVersions.has(releasePackageVersion)) {
    throw new Error(
      `Release tag ${tag} expects package version ${[...expectedPackageVersions].join(" or ")}, found ${releasePackageVersion}.`,
    );
  }

  const comparison = compareReleaseVersions(currentVersion, releasePackageVersion);
  if (comparison === null) {
    throw new Error(
      `Unable to compare main package version ${currentVersion} with release package version ${releasePackageVersion}.`,
    );
  }

  return {
    currentVersion,
    releasePackageVersion,
    shouldSync: comparison < 0,
    tag,
  };
}

function parseStableReleaseTag(tag) {
  if (!tag.startsWith("v")) {
    throw new Error(`Release tag must start with "v": ${tag}`);
  }

  const parsedTag = parseReleaseVersion(tag.slice(1));
  if (parsedTag === null) {
    throw new Error(`Unsupported release tag: ${tag}`);
  }
  if (parsedTag.channel !== "stable") {
    throw new Error(`Main version sync only supports stable release tags: ${tag}`);
  }
  return parsedTag;
}

function readPackageVersion(packagePath) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${packagePath} is missing a package version.`);
  }
  return pkg.version;
}

function readReleasePackageVersion(rootDir, tag) {
  const raw = execFileSync("git", ["show", `${tag}:package.json`], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${tag}:package.json is missing a package version.`);
  }
  return pkg.version;
}

function writePackageVersion(packagePath, version) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export async function syncMainReleaseVersion({
  rootDir = process.cwd(),
  tag,
  readReleaseVersion = readReleasePackageVersion,
  runCommand = runManagedCommand,
}) {
  parseStableReleaseTag(tag);
  const packagePath = path.join(rootDir, "package.json");
  const currentVersion = readPackageVersion(packagePath);
  const releasePackageVersion = readReleaseVersion(rootDir, tag);
  const plan = planMainReleaseVersionSync({
    tag,
    currentVersion,
    releasePackageVersion,
  });

  if (!plan.shouldSync) {
    return plan;
  }

  writePackageVersion(packagePath, releasePackageVersion);
  for (const command of SYNC_COMMANDS) {
    console.log(`[main-version-sync] ${command.name}: pnpm ${command.args.join(" ")}`);
    const status = await runCommand({
      args: command.args,
      bin: "pnpm",
      cwd: rootDir,
    });
    if (status !== 0) {
      throw new Error(`${command.name} failed with exit ${status}.`);
    }
  }

  return plan;
}

async function main(argv = process.argv.slice(2)) {
  const { tag } = parseArgs(argv);
  const result = await syncMainReleaseVersion({ tag });
  if (result.shouldSync) {
    console.log(
      `[main-version-sync] synchronized main package metadata from ${result.currentVersion} to ${result.releasePackageVersion}.`,
    );
  } else {
    console.log(
      `[main-version-sync] main package version ${result.currentVersion} is already at or ahead of ${result.releasePackageVersion}.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
