import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";

/** Fingerprints every desktop candidate that can own a managed fallback artifact. */
export async function readMacOSDesktopGenerationFingerprint(
  candidates: readonly MacOSDesktopCodexAppPathCandidate[] = resolveMacOSDesktopCodexAppPathCandidates(
    "darwin",
  ),
): Promise<string> {
  const entries: string[] = [];
  const bundles = new Set<string>();
  for (const candidate of candidates) {
    const command = await statFingerprint(candidate.appServerCommandPath);
    entries.push(`candidate:${candidate.appName}:${candidate.appServerCommandPath}:${command}`);
    // Executable layouts share one bundle's Computer Use assets.
    if (bundles.has(candidate.appBundlePath)) {
      continue;
    }
    bundles.add(candidate.appBundlePath);
    entries.push(`${candidate.appBundlePath}\0${await statFingerprint(candidate.appBundlePath)}`);
  }
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

async function statFingerprint(filePath: string): Promise<string> {
  try {
    // Ordinary desktop replacement changes these identities. Manual nested edits
    // are best effort; explicit Computer Use install refreshes generated copies.
    return statTuple(await fs.stat(filePath, { bigint: true }));
  } catch (error) {
    return missingFingerprint(error);
  }
}

function statTuple(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function missingFingerprint(error: unknown): "missing" {
  const code = extractErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "missing";
  }
  throw error;
}
