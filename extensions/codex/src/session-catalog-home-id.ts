import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";

function canonicalCodexCatalogHome(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Homes not created yet use their resolved path until native startup creates them.
    return resolved;
  }
}

/** One canonical identity for catalog discovery and durable ownership rows. */
export function codexCatalogHomeId(codexHome: string): string {
  return codexCatalogHomeIdFromCanonicalPath(canonicalCodexCatalogHome(codexHome));
}

/** Hashes lifecycle-prepared paths without repeating filesystem discovery. */
export function codexCatalogHomeIdFromCanonicalPath(codexHome: string): string {
  return sha256Hex(`openclaw:codex-session-catalog-home:v1\0${codexHome}`);
}
