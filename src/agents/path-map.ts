import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";

export type PathMapRoots = Record<string, string>;

export function normalizePathMapRoots(roots?: PathMapRoots): PathMapRoots {
  if (!roots) {
    return {};
  }
  const normalized: PathMapRoots = {};
  for (const [rawKey, rawValue] of Object.entries(roots)) {
    const key = String(rawKey).trim();
    const value = String(rawValue).trim();
    if (!key || !value) {
      continue;
    }
    const normKey = key.startsWith("@") ? key : `@${key}`;
    const normValue = value.replace(/[\\/]+$/, "");
    normalized[normKey] = normValue;
  }
  return normalized;
}

export function resolvePathMapRoots(cfg?: OpenClawConfig): PathMapRoots {
  return normalizePathMapRoots(cfg?.pathMap?.roots);
}

function sortRootsByLengthDesc(roots: PathMapRoots): Array<[string, string]> {
  return Object.entries(roots).sort((a, b) => b[1].length - a[1].length);
}

export function toLogicalPath(inputPath: string, roots: PathMapRoots): string {
  const raw = String(inputPath ?? "");
  if (!raw) {
    return raw;
  }
  const entries = sortRootsByLengthDesc(roots);
  for (const [logicalRoot, physicalRoot] of entries) {
    if (raw === physicalRoot) {
      return logicalRoot;
    }
    if (raw.startsWith(physicalRoot + path.sep) || raw.startsWith(physicalRoot + "/")) {
      const rel = raw.slice(physicalRoot.length);
      return `${logicalRoot}${rel}`;
    }
  }
  return raw;
}

export function toPhysicalPath(inputPath: string, roots: PathMapRoots): string {
  const raw = String(inputPath ?? "");
  if (!raw) {
    return raw;
  }
  for (const [logicalRoot, physicalRoot] of Object.entries(roots)) {
    if (raw === logicalRoot) {
      return physicalRoot;
    }
    if (raw.startsWith(logicalRoot + "/")) {
      const rel = raw.slice(logicalRoot.length);
      return `${physicalRoot}${rel}`;
    }
  }
  return raw;
}
