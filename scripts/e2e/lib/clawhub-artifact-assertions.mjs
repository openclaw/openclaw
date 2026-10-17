import fs from "node:fs";
import path from "node:path";
import { assertRealPathInside } from "./openclaw-state-paths.mjs";

export function assertClawHubExternalInstallContract(installPath, label) {
  const openclawPeerPath = path.join(installPath, "node_modules", "openclaw");
  if (!fs.existsSync(openclawPeerPath)) {
    throw new Error(`missing ${label} openclaw peer symlink: ${openclawPeerPath}`);
  }
  if (!fs.lstatSync(openclawPeerPath).isSymbolicLink()) {
    throw new Error(`${label} openclaw peer is not a symlink: ${openclawPeerPath}`);
  }
  const hostRoot = fs.realpathSync(process.cwd());
  const linkedHostRoot = fs.realpathSync(openclawPeerPath);
  if (linkedHostRoot !== hostRoot) {
    throw new Error(`expected ${label} openclaw peer ${linkedHostRoot} to target ${hostRoot}`);
  }

  const dependencyPackagePath = path.join(installPath, "node_modules", "is-number", "package.json");
  if (fs.existsSync(dependencyPackagePath)) {
    assertRealPathInside(installPath, dependencyPackagePath, `${label} isolated dependency`);
  }
}

export function assertClawHubArtifactMetadata(record, messagePrefixes) {
  if (record.artifactKind === "legacy-zip") {
    if (record.artifactFormat !== "zip") {
      throw new Error(`${messagePrefixes.legacyZip}: ${JSON.stringify(record)}`);
    }
    return;
  }

  if (record.artifactKind !== "npm-pack" || record.artifactFormat !== "tgz") {
    throw new Error(`${messagePrefixes.artifact}: ${JSON.stringify(record)}`);
  }
  if (!record.clawpackSha256 || typeof record.clawpackSize !== "number") {
    throw new Error(`${messagePrefixes.clawpack}: ${JSON.stringify(record)}`);
  }
  if (!record.npmIntegrity || !record.npmShasum || !record.npmTarballName) {
    throw new Error(`${messagePrefixes.npm}: ${JSON.stringify(record)}`);
  }
}
