import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_CRYPTO_INSPECTOR_BASENAME_RE = /^legacy-crypto-inspector(?:[-.].*)?\.js$/u;

function hasSourceInspectorArtifact(currentDir: string): boolean {
  return [
    path.resolve(currentDir, "..", "legacy-crypto-inspector.ts"),
    path.resolve(currentDir, "..", "legacy-crypto-inspector.js"),
  ].some((candidate) => fs.existsSync(candidate));
}

function hasBuiltInspectorArtifact(currentDir: string): boolean {
  if (fs.existsSync(path.join(currentDir, "legacy-crypto-inspector.js"))) {
    return true;
  }
  if (fs.existsSync(path.join(currentDir, "extensions", "matrix", "legacy-crypto-inspector.js"))) {
    return true;
  }
  return fs
    .readdirSync(currentDir, { withFileTypes: true })
    .some((entry) => entry.isFile() && LEGACY_CRYPTO_INSPECTOR_BASENAME_RE.test(entry.name));
}

export function isMatrixLegacyCryptoInspectorAvailable(): boolean {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  if (hasSourceInspectorArtifact(currentDir)) {
    return true;
  }
  try {
    return hasBuiltInspectorArtifact(currentDir);
  } catch {
    return false;
  }
}
