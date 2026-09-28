import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { sha256File } from "openclaw/plugin-sdk/file-access-runtime";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";

const MAX_COMPUTER_USE_PLUGIN_TREE_ENTRIES = 4_096;

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
    for (const artifactPath of resolveMacOSDesktopGenerationPaths(candidate)) {
      entries.push(`${artifactPath}\0${await statFingerprint(artifactPath)}`);
    }
    for (const pluginRoot of resolveComputerUseArtifactRoots(candidate)) {
      entries.push(`${pluginRoot}\0${await readCodexDesktopArtifactTreeFingerprint(pluginRoot)}`);
    }
  }
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

function resolveMacOSDesktopGenerationPaths(
  candidate: MacOSDesktopCodexAppPathCandidate,
): string[] {
  return [
    candidate.appBundlePath,
    path.join(candidate.bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
    path.join(candidate.appBundlePath, "Contents", "Resources", "cua_node", "bin", "node"),
    path.join(candidate.appBundlePath, "Contents", "Resources", "cua_node", "bin", "node_repl"),
    ...candidate.computerUseServiceAppPaths.flatMap((servicePath) => [
      servicePath,
      path.join(servicePath, "Contents", "Info.plist"),
      path.join(
        servicePath,
        "Contents",
        "SharedSupport",
        "SkyComputerUseClient.app",
        "Contents",
        "MacOS",
        "SkyComputerUseClient",
      ),
    ]),
  ];
}

function resolveComputerUseArtifactRoots(candidate: MacOSDesktopCodexAppPathCandidate): string[] {
  const modules = path.join(
    candidate.appBundlePath,
    "Contents",
    "Resources",
    "cua_node",
    "lib",
    "node_modules",
    "@oai",
  );
  return [
    path.join(candidate.bundledMarketplacePath, "plugins", "computer-use"),
    path.join(candidate.bundledMarketplacePath, "plugins", "unified-computer-use"),
    path.join(modules, "cua-repl"),
    path.join(modules, "cua"),
    path.join(modules, "sky", "dist"),
  ];
}

/** Stable roots that cover bundle replacement and recursive artifact updates. */
export function resolveMacOSDesktopGenerationWatchPaths(
  candidates: readonly MacOSDesktopCodexAppPathCandidate[] = resolveMacOSDesktopCodexAppPathCandidates(
    "darwin",
  ),
): string[] {
  const watched = new Set<string>(["/Applications"]);
  for (const candidate of candidates) {
    watched.add(candidate.appBundlePath);
  }
  return [...watched];
}

export async function readCodexDesktopArtifactTreeFingerprint(root: string): Promise<string> {
  let rootStat: BigIntStats;
  try {
    rootStat = await fs.lstat(root, { bigint: true });
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "missing";
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    return statFingerprint(root);
  }

  let entryCount = 0;
  const hash = createHash("sha256");
  hash.update("openclaw-codex-computer-use-plugin-tree-v1\0");
  const visit = async (directory: string, relativeDirectory: string, before: BigIntStats) => {
    hash.update(`directory\0${relativeDirectory}\0${statTuple(before)}\0`);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).toSorted(
      (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_COMPUTER_USE_PLUGIN_TREE_ENTRIES) {
        throw new Error("Codex Computer Use plugin exceeds the bounded tree size");
      }
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      const entryStat = await fs.lstat(entryPath, { bigint: true });
      if (entryStat.isDirectory()) {
        await visit(entryPath, relativePath, entryStat);
      } else {
        hash.update(`entry\0${relativePath}\0${await statFingerprint(entryPath)}\0`);
      }
    }
    const after = await fs.lstat(directory, { bigint: true });
    if (!sameStat(before, after)) {
      throw new Error(`Codex desktop artifact changed while fingerprinting: ${directory}`);
    }
  };
  await visit(root, ".", rootStat);
  return hash.digest("hex");
}

async function statFingerprint(filePath: string): Promise<string> {
  try {
    const entry = await fs.lstat(filePath, { bigint: true });
    const type = entry.isSymbolicLink()
      ? "link"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
    const own = statTuple(entry);
    if (!entry.isSymbolicLink()) {
      const content = entry.isFile() ? await readFileFingerprint(filePath, entry, false) : "";
      return `${type}:${own}:${content}`;
    }
    const [link, realPath, target] = await Promise.all([
      fs.readlink(filePath),
      fs.realpath(filePath),
      fs.stat(filePath, { bigint: true }),
    ]);
    const content = target.isFile() ? await readFileFingerprint(filePath, target, true) : "";
    return `${type}:${own}:${link}:${realPath}:${statTuple(target)}:${content}`;
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "missing";
    }
    throw error;
  }
}

async function readFileFingerprint(
  filePath: string,
  expected: BigIntStats,
  followsSymlink: boolean,
): Promise<string> {
  const noFollow = followsSymlink ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameStat(before, expected)) {
      throw new Error(`Codex desktop artifact changed while fingerprinting: ${filePath}`);
    }
    // Metadata can collide on coarse filesystems. Content binds an event-driven generation
    // to the exact executable/config bytes without adding request-hot-path polling.
    const hash = await sha256File(handle, { maxBytes: Number(before.size) });
    const after = await handle.stat({ bigint: true });
    if (BigInt(hash.bytes) !== before.size || !sameStat(before, after)) {
      throw new Error(`Codex desktop artifact changed while fingerprinting: ${filePath}`);
    }
    return hash.digest;
  } finally {
    await handle.close();
  }
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return statTuple(left) === statTuple(right);
}

function statTuple(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
