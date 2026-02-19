#!/usr/bin/env -S node --import tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeUiAssetManifest } from "../src/infra/ui-asset-manifest.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlUiRoot = path.join(rootDir, "dist", "control-ui");

const { manifestSha, outputPath, manifest } = writeUiAssetManifest(controlUiRoot);
process.stdout.write(
  `ui-manifest: wrote ${outputPath} (${Object.keys(manifest.files).length} files, sha=${manifestSha})\n`,
);
