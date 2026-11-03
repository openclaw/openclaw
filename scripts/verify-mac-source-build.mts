#!/usr/bin/env node
// Packaging may consume an already-running source generation without rewriting dist.
import fs from "node:fs";
import path from "node:path";
import { resolveGitHead } from "./lib/local-build-metadata.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveRunNodePreparation } from "./run-node.mts";
import { normalizeBuildTimestamp } from "./write-build-info.ts";

const [root, version, commit] = process.argv.slice(2);
if (!root || !version || !commit) {
  throw new Error("Usage: verify-mac-source-build.mts <root> <version> <commit>");
}
if (resolveGitHead({ cwd: root }) !== commit) {
  throw new Error("Reusable Mac runtime must match the checked-out Git commit.");
}
const preparation = resolveRunNodePreparation(root, process.env);
if (preparation.build || preparation.runtime) {
  throw new Error(
    "Mac runtime source artifacts are stale or incomplete; rebuild while the Gateway is stopped.",
  );
}
const info: unknown = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
if (
  !isRecord(info) ||
  info.version !== version ||
  info.commit !== commit ||
  typeof info.buildId !== "string" ||
  !info.buildId.trim() ||
  typeof info.builtAt !== "string"
) {
  throw new Error("Reusable Mac runtime build provenance does not match this app.");
}
process.stdout.write(normalizeBuildTimestamp(info.builtAt));
