#!/usr/bin/env -S node --import tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UI_ASSET_MANIFEST_FILE,
  verifyUiAssetManifest,
  type UiAssetManifest,
} from "../src/infra/ui-asset-manifest.js";

type BuildInfo = {
  version?: string | null;
  git_sha?: string | null;
  build_id?: string | null;
  ui_manifest_sha?: string | null;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlUiRoot = path.join(rootDir, "dist", "control-ui");
const buildInfoPath = path.join(rootDir, "dist", "build-info.json");

function fail(message: string): never {
  console.error(`provenance-check: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(controlUiRoot, UI_ASSET_MANIFEST_FILE))) {
  fail(`missing dist/control-ui/${UI_ASSET_MANIFEST_FILE}`);
}

const manifestCheck = verifyUiAssetManifest(controlUiRoot);
if (!manifestCheck.ok) {
  fail(`invalid UI manifest: ${manifestCheck.errors.join("; ")}`);
}

if (!fs.existsSync(buildInfoPath)) {
  fail("missing dist/build-info.json");
}

let buildInfo: BuildInfo;
try {
  buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8")) as BuildInfo;
} catch (err) {
  fail(`invalid dist/build-info.json: ${String(err)}`);
}

for (const field of ["git_sha", "build_id", "ui_manifest_sha"] as const) {
  const value = buildInfo[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`dist/build-info.json missing required field: ${field}`);
  }
}

if (buildInfo.ui_manifest_sha !== manifestCheck.manifestSha) {
  fail(
    `ui_manifest_sha mismatch: build-info=${buildInfo.ui_manifest_sha} manifest=${manifestCheck.manifestSha}`,
  );
}

console.log("provenance-check: OK");
