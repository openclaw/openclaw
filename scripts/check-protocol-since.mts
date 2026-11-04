#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Enforces release-train metadata on core gateway methods.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  classifyMethodSpecs,
  collectSnapshotMethodSpecs,
  snapshotReader,
} from "./lib/protocol-since-specs.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const descriptorPath = "src/gateway/methods/core-descriptors.ts";

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`;
    throw new Error(
      `${detail}\nRun git fetch origin main so origin/main and its merge-base are available.`,
    );
  }
  return result.stdout.trim();
}

function tryRunGit(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveBaseCommit(): string {
  const explicitBase = process.env.PROTOCOL_SINCE_BASE_SHA?.trim();
  if (explicitBase) {
    if (!/^[0-9a-f]{40}$/u.test(explicitBase)) {
      throw new Error("PROTOCOL_SINCE_BASE_SHA must be a full commit SHA.");
    }
    if (tryRunGit(["cat-file", "-e", `${explicitBase}:${descriptorPath}`]) === undefined) {
      throw new Error(`PROTOCOL_SINCE_BASE_SHA ${explicitBase} is unavailable in this checkout.`);
    }
    return explicitBase;
  }
  const mainMergeBase = tryRunGit(["merge-base", "HEAD", "origin/main"]);
  if (mainMergeBase) {
    return mainMergeBase;
  }
  // Pull-request CI checks out a synthetic merge commit without creating origin/main.
  // Its first parent is the exact base used to build the merge result.
  const parents = (tryRunGit(["show", "-s", "--format=%P", "HEAD"]) ?? "").split(/\s+/u);
  if (parents.length === 2 && parents[0]) {
    return parents[0];
  }
  throw new Error(
    "Could not resolve PROTOCOL_SINCE_BASE_SHA, origin/main, or a two-parent pull-request merge checkout.",
  );
}

function currentTrain(read: (file: string) => string): string {
  const packageJson: unknown = JSON.parse(read("package.json"));
  if (!isRecord(packageJson)) {
    throw new Error("Root package.json must contain an object.");
  }
  const version = typeof packageJson.version === "string" ? packageJson.version : "";
  const match = /^(\d{4})\.(\d{1,2})(?:\.|$)/.exec(version);
  if (!match) {
    throw new Error(`Root package version ${JSON.stringify(packageJson.version)} is not calver.`);
  }
  return `${match[1]!}.${match[2]!}`;
}

try {
  const mergeBase = resolveBaseCommit();
  const readCurrent = snapshotReader(
    process.argv.includes("--staged") ? { kind: "index" } : { kind: "worktree" },
    (file) => fs.readFileSync(path.join(repoRoot, file), "utf8"),
    runGit,
  );
  const readBase = snapshotReader(
    { kind: "tree", ref: mergeBase },
    (file) => fs.readFileSync(path.join(repoRoot, file), "utf8"),
    runGit,
  );
  const train = currentTrain(readCurrent);
  const currentSpecs = collectSnapshotMethodSpecs(descriptorPath, readCurrent);
  const baseSpecs = collectSnapshotMethodSpecs(descriptorPath, readBase);
  const { restored, newMethods, violations } = classifyMethodSpecs(currentSpecs, baseSpecs, train);

  if (violations.length > 0) {
    console.error(`Protocol since guard failed for current train ${train}:`);
    for (const spec of violations) {
      const problem = spec.compatibilityRestored
        ? `is marked compatibilityRestored but has non-historical since ${JSON.stringify(spec.since)}`
        : spec.since
          ? `has since ${JSON.stringify(spec.since)}`
          : "is missing since metadata";
      console.error(
        spec.compatibilityRestored
          ? `- ${descriptorPath}:${spec.line} ${spec.name} ${problem}; restored compatibility methods must retain <= vintage metadata.`
          : `- ${descriptorPath}:${spec.line} ${spec.name} ${problem}; add since: ${JSON.stringify(train)}.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `protocol since guard passed: ${newMethods.length} new core method${newMethods.length === 1 ? "" : "s"} use train ${train}; ${restored.length} restored compatibility method${restored.length === 1 ? "" : "s"} retain historical vintage`,
    );
  }
} catch (error) {
  console.error(
    `Protocol since guard failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
