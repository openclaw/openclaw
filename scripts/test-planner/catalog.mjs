import fs from "node:fs";
import path from "node:path";
import { channelTestPrefixes } from "../../vitest.channel-paths.mjs";
import { isUnitConfigTestFile } from "../../vitest.unit-paths.mjs";
import { dedupeFilesPreserveOrder, loadTestRunnerBehavior } from "../test-runner-manifest.mjs";

const baseConfigPrefixes = ["src/agents/", "src/auto-reply/", "src/commands/", "test/", "ui/"];

export const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const toRepoRelativePath = (value) => {
  const relativePath = normalizeRepoPath(path.relative(process.cwd(), path.resolve(value)));
  return relativePath.startsWith("../") || relativePath === ".." ? null : relativePath;
};

const walkTestFiles = (rootDir) => {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      fullPath.endsWith(".test.ts") ||
      fullPath.endsWith(".live.test.ts") ||
      fullPath.endsWith(".e2e.test.ts")
    ) {
      files.push(normalizeRepoPath(fullPath));
    }
  }
  return files;
};

export function loadTestCatalog() {
  const behaviorManifest = loadTestRunnerBehavior();
  const existingFiles = (entries) =>
    entries.map((entry) => entry.file).filter((file) => fs.existsSync(file));
  const existingUnitConfigFiles = (entries) => existingFiles(entries).filter(isUnitConfigTestFile);
  const baseThreadPinnedFiles = existingFiles(behaviorManifest.base?.threadPinned ?? []);
  const channelIsolatedManifestFiles = existingFiles(behaviorManifest.channels?.isolated ?? []);
  const channelIsolatedPrefixes = behaviorManifest.channels?.isolatedPrefixes ?? [];
  const extensionForkIsolatedFiles = existingFiles(behaviorManifest.extensions?.isolated ?? []);
  const unitForkIsolatedFiles = existingUnitConfigFiles(behaviorManifest.unit.isolated);
  const unitThreadPinnedFiles = existingUnitConfigFiles(behaviorManifest.unit.threadPinned);
  const unitBehaviorOverrideSet = new Set([...unitForkIsolatedFiles, ...unitThreadPinnedFiles]);
  const allKnownTestFiles = [
    ...new Set([
      ...walkTestFiles("src"),
      ...walkTestFiles("extensions"),
      ...walkTestFiles("packages"),
      ...walkTestFiles("test"),
      ...walkTestFiles(path.join("ui", "src", "ui")),
    ]),
  ];
  const channelIsolatedFiles = dedupeFilesPreserveOrder([
    ...channelIsolatedManifestFiles,
    ...allKnownTestFiles.filter((file) =>
      channelIsolatedPrefixes.some((prefix) => file.startsWith(prefix)),
    ),
  ]);
  const channelIsolatedFileSet = new Set(channelIsolatedFiles);
  const extensionForkIsolatedFileSet = new Set(extensionForkIsolatedFiles);
  const baseThreadPinnedFileSet = new Set(baseThreadPinnedFiles);
  const unitThreadPinnedFileSet = new Set(unitThreadPinnedFiles);
  const unitForkIsolatedFileSet = new Set(unitForkIsolatedFiles);

  const classifyTestFile = (fileFilter, options = {}) => {
    const normalizedFile = normalizeRepoPath(fileFilter);
    const reasons = [];
    const isolated =
      options.unitMemoryIsolatedFiles?.includes(normalizedFile) ||
      unitForkIsolatedFileSet.has(normalizedFile) ||
      extensionForkIsolatedFileSet.has(normalizedFile) ||
      channelIsolatedFileSet.has(normalizedFile);
    if (options.unitMemoryIsolatedFiles?.includes(normalizedFile)) {
      reasons.push("unit-memory-isolated");
    }
    if (unitForkIsolatedFileSet.has(normalizedFile)) {
      reasons.push("unit-isolated-manifest");
    }
    if (extensionForkIsolatedFileSet.has(normalizedFile)) {
      reasons.push("extensions-isolated-manifest");
    }
    if (channelIsolatedFileSet.has(normalizedFile)) {
      reasons.push("channels-isolated-rule");
    }

    let surface = "base";
    if (isUnitConfigTestFile(normalizedFile)) {
      surface = "unit";
    } else if (normalizedFile.endsWith(".live.test.ts")) {
      surface = "live";
    } else if (normalizedFile.endsWith(".e2e.test.ts")) {
      surface = "e2e";
    } else if (channelTestPrefixes.some((prefix) => normalizedFile.startsWith(prefix))) {
      surface = "channels";
    } else if (normalizedFile.startsWith("extensions/")) {
      surface = "extensions";
    } else if (normalizedFile.startsWith("src/gateway/")) {
      surface = "gateway";
    } else if (baseConfigPrefixes.some((prefix) => normalizedFile.startsWith(prefix))) {
      surface = "base";
    } else if (normalizedFile.startsWith("src/")) {
      surface = "unit";
    }
    if (surface === "unit") {
      reasons.push("unit-surface");
    } else if (surface !== "base") {
      reasons.push(`${surface}-surface`);
    } else {
      reasons.push("base-surface");
    }

    const legacyBasePinned = baseThreadPinnedFileSet.has(normalizedFile);
    if (legacyBasePinned) {
      reasons.push("base-pinned-manifest");
    }
    if (unitThreadPinnedFileSet.has(normalizedFile)) {
      reasons.push("unit-pinned-manifest");
    }

    return {
      file: normalizedFile,
      surface,
      isolated,
      legacyBasePinned,
      reasons,
    };
  };

  const resolveFilterMatches = (fileFilter) => {
    const normalizedFilter = normalizeRepoPath(fileFilter);
    const repoRelativeFilter = toRepoRelativePath(fileFilter);
    if (fs.existsSync(fileFilter)) {
      const stats = fs.statSync(fileFilter);
      if (stats.isFile()) {
        if (repoRelativeFilter && allKnownTestFiles.includes(repoRelativeFilter)) {
          return [repoRelativeFilter];
        }
        throw new Error(`Explicit path ${fileFilter} is not a known test file.`);
      }
      if (stats.isDirectory()) {
        if (!repoRelativeFilter) {
          throw new Error(`Explicit path ${fileFilter} is outside the repo test roots.`);
        }
        const prefix = repoRelativeFilter.endsWith("/")
          ? repoRelativeFilter
          : `${repoRelativeFilter}/`;
        const matches = allKnownTestFiles.filter((file) => file.startsWith(prefix));
        if (matches.length === 0) {
          throw new Error(`Explicit path ${fileFilter} does not contain known test files.`);
        }
        return matches;
      }
    }
    if (/[*?[\]{}]/.test(normalizedFilter)) {
      return allKnownTestFiles.filter((file) => path.matchesGlob(file, normalizedFilter));
    }
    return allKnownTestFiles.filter((file) => file.includes(normalizedFilter));
  };

  return {
    allKnownTestFiles,
    allKnownUnitFiles: allKnownTestFiles.filter((file) => isUnitConfigTestFile(file)),
    baseThreadPinnedFiles,
    channelIsolatedFiles,
    channelIsolatedFileSet,
    channelTestPrefixes,
    extensionForkIsolatedFiles,
    extensionForkIsolatedFileSet,
    unitBehaviorOverrideSet,
    unitForkIsolatedFiles,
    unitThreadPinnedFiles,
    baseThreadPinnedFileSet,
    classifyTestFile,
    resolveFilterMatches,
  };
}

export const testSurfaces = ["unit", "extensions", "channels", "gateway", "live", "e2e", "base"];
