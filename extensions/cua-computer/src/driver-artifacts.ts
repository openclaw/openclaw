import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pluginManifest from "../package.json" with { type: "json" };
import {
  inspectCuaDriverArtifacts,
  readPackageIdentity,
  type CuaDriverArtifactVerification,
} from "./driver-artifact-verification.js";

const requireFromPlugin = createRequire(import.meta.url);

function resolvePackageEntry(packageName: string): string | undefined {
  try {
    return requireFromPlugin.resolve(packageName);
  } catch {
    // Import-only packages are resolved with import conditions below.
  }
  // The CUA Driver SDK is ESM-only: its exports map carries only the "import"
  // condition, so require-condition resolution throws PATH_NOT_EXPORTED even
  // when the package is installed. Resolve with import conditions before
  // concluding the package is missing.
  try {
    return fileURLToPath(import.meta.resolve(packageName));
  } catch {
    return undefined;
  }
}

function resolvePackageJson(packageName: string): string | undefined {
  if (packageName !== "@trycua/cua-driver") {
    const sdkManifestPath = resolvePackageJson("@trycua/cua-driver");
    if (!sdkManifestPath) {
      return undefined;
    }
    // Native packages belong to the SDK, not the plugin's dependency tree.
    try {
      return createRequire(sdkManifestPath).resolve(`${packageName}/package.json`);
    } catch {
      return undefined;
    }
  }
  try {
    return requireFromPlugin.resolve(`${packageName}/package.json`);
  } catch {
    // The exports map may hide package.json; find the manifest from its entry below.
  }
  const entry = resolvePackageEntry(packageName);
  if (!entry) {
    return undefined;
  }
  let current = path.dirname(entry);
  while (true) {
    const candidate = path.join(current, "package.json");
    try {
      if (readPackageIdentity(candidate).name === packageName) {
        return candidate;
      }
    } catch {
      // Ancestors without a readable matching manifest are not the package root.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function detectLinuxLibc(): "gnu" | "musl" | undefined {
  // Diagnostic reports also enumerate native stacks and network interfaces,
  // which can block Gateway registration for minutes. Read the loaded libc instead.
  try {
    const maps = fs.readFileSync("/proc/self/maps", "utf8");
    if (/\/(?:ld-musl-|libc\.musl-)/u.test(maps)) {
      return "musl";
    }
    return /\/libc(?:\.so\.6|-\d[\d.]*\.so)(?:\s|$)/mu.test(maps) ? "gnu" : undefined;
  } catch {
    // Restricted procfs must produce the existing unknown-libc diagnostic, not a guess.
    return undefined;
  }
}

let installedVerification: CuaDriverArtifactVerification | undefined;

export function verifyInstalledCuaDriverArtifacts(): CuaDriverArtifactVerification {
  installedVerification ??= inspectCuaDriverArtifacts({
    platform: process.platform,
    arch: process.arch,
    ...(process.platform === "linux" ? { linuxLibc: detectLinuxLibc() } : {}),
    pluginManifest,
    resolvePackageJson,
  });
  return installedVerification;
}
