import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicPluginSdkEntrypoints } from "../lib/plugin-sdk-entries.mjs";

export const PLUGIN_SDK_CLASSIFICATION_PREFIX = "plugin-sdk:";
export const PLUGIN_SDK_CLASSIFICATIONS = [
  "plugin-sdk:private-only",
  "plugin-sdk:test-only",
  "plugin-sdk:additive-api",
  "plugin-sdk:behavior-change",
  "plugin-sdk:breaking-change",
  "plugin-sdk:architecture-change",
];

export const PLUGIN_SDK_REQUIRES_MAINTAINER_APPROVAL = new Set([
  "plugin-sdk:additive-api",
  "plugin-sdk:behavior-change",
  "plugin-sdk:breaking-change",
  "plugin-sdk:architecture-change",
]);

export const PLUGIN_SDK_REQUIRES_RFC = new Set([
  "plugin-sdk:breaking-change",
  "plugin-sdk:architecture-change",
]);

const classificationSet = new Set(PLUGIN_SDK_CLASSIFICATIONS);
const publicPluginSdkEntrypointSet = new Set(publicPluginSdkEntrypoints);
const clawsweeperBotLogins = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const classificationSeverity = new Map([
  ["", 0],
  ["plugin-sdk:private-only", 1],
  ["plugin-sdk:test-only", 1],
  ["plugin-sdk:additive-api", 2],
  ["plugin-sdk:behavior-change", 2],
  ["plugin-sdk:breaking-change", 3],
  ["plugin-sdk:architecture-change", 4],
]);

function normalizeClassification(value) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase();
  const classification = trimmed.startsWith(PLUGIN_SDK_CLASSIFICATION_PREFIX)
    ? trimmed
    : `${PLUGIN_SDK_CLASSIFICATION_PREFIX}${trimmed}`;
  return classificationSet.has(classification) ? classification : "";
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function labelNames(labels) {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((label) => typeof label === "string");
}

function changedFilePath(file) {
  return normalizePath(typeof file === "string" ? file : file?.filename);
}

function changedFilePaths(file) {
  const paths = [changedFilePath(file)];
  if (typeof file === "object" && file !== null) {
    paths.push(normalizePath(file.previous_filename ?? file.previousFilename));
  }
  return [...new Set(paths.filter(Boolean))];
}

function changedFilePatch(file) {
  return typeof file === "object" && file ? String(file.patch ?? "") : "";
}

function hasChangedFilePatch(file) {
  return typeof file === "object" && file !== null && Object.hasOwn(file, "patch");
}

function pathBasename(filePath) {
  const parts = filePath.split("/");
  return parts.at(-1) ?? filePath;
}

function packageJsonPatchTouchesPluginSdk(patch) {
  return /\bplugin-sdk\b/i.test(patch);
}

function normalizeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function sourceCandidatePaths(rawPath) {
  const extension = path.extname(rawPath);
  if (extension === ".js") {
    return [
      rawPath.slice(0, -3) + ".ts",
      rawPath.slice(0, -3) + ".tsx",
      rawPath.slice(0, -3) + ".mts",
      rawPath,
    ];
  }
  if (extension) {
    return [rawPath];
  }
  return [
    `${rawPath}.ts`,
    `${rawPath}.tsx`,
    `${rawPath}.mts`,
    `${rawPath}.cts`,
    `${rawPath}.js`,
    path.join(rawPath, "index.ts"),
  ];
}

function resolveImportSource(currentFile, specifier) {
  const candidates = [];
  if (specifier.startsWith(".")) {
    candidates.push(...sourceCandidatePaths(path.resolve(path.dirname(currentFile), specifier)));
  } else if (specifier.startsWith("@openclaw/")) {
    const [, packageName, ...subpathParts] = specifier.split("/");
    const subpath = subpathParts.length > 0 ? subpathParts.join("/") : "index";
    candidates.push(
      ...sourceCandidatePaths(path.join(repoRoot, "packages", packageName, "src", subpath)),
    );
  }

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function importedSpecifiers(source) {
  const specifiers = [];
  const regex =
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(regex)) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers.filter(Boolean);
}

function buildPublicPluginSdkDependencyPathSet() {
  const dependencyPaths = new Set();
  const visited = new Set();
  const stack = publicPluginSdkEntrypoints.map((entrypoint) =>
    path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`),
  );

  while (stack.length > 0) {
    const currentFile = stack.pop();
    if (!currentFile || visited.has(currentFile)) {
      continue;
    }
    visited.add(currentFile);
    const relative = normalizeRepoPath(currentFile);
    if (!relative.startsWith("src/") && !relative.startsWith("packages/")) {
      continue;
    }
    dependencyPaths.add(relative);

    let source;
    try {
      source = fs.readFileSync(currentFile, "utf8");
    } catch {
      continue;
    }
    for (const specifier of importedSpecifiers(source)) {
      const resolved = resolveImportSource(currentFile, specifier);
      if (resolved) {
        stack.push(resolved);
      }
    }
  }

  return dependencyPaths;
}

const publicPluginSdkDependencyPaths = buildPublicPluginSdkDependencyPathSet();

function isPluginSdkScriptPath(filePath) {
  if (!filePath.startsWith("scripts/")) {
    return false;
  }
  const basename = pathBasename(filePath);
  return /\bplugin-sdk\b/i.test(basename) || /^scripts\/lib\/plugin-sdk-/u.test(filePath);
}

/** Return true when a changed PR file belongs to the plugin SDK impact gate. */
export function isPluginSdkImpactPath(file) {
  if (
    changedFilePaths(file).some((filePath) => filePath === "package.json") &&
    (!hasChangedFilePatch(file) || packageJsonPatchTouchesPluginSdk(changedFilePatch(file)))
  ) {
    return true;
  }
  return changedFilePaths(file).some(isPluginSdkImpactRepoPath);
}

function isPluginSdkImpactRepoPath(filePath) {
  if (!filePath) {
    return false;
  }
  if (filePath.startsWith("src/plugin-sdk/")) {
    return true;
  }
  if (filePath.startsWith("packages/plugin-sdk/")) {
    return true;
  }
  if (publicPluginSdkDependencyPaths.has(filePath)) {
    return true;
  }
  if (filePath === "docs/.generated/plugin-sdk-api-baseline.sha256") {
    return true;
  }
  if (isPluginSdkScriptPath(filePath)) {
    return true;
  }
  if (filePath === "src/plugins/types.ts" || filePath === "src/plugins/runtime/types.ts") {
    return true;
  }
  return filePath.startsWith("src/channels/plugins/");
}

function isTestOnlyPluginSdkPath(filePath) {
  return (
    /(?:^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|$)/u.test(filePath) ||
    /\.(?:test|spec|fixture|fixtures)\.[cm]?[jt]sx?$/u.test(filePath) ||
    filePath.startsWith("test/")
  );
}

function pluginSdkEntrypointFromSourcePath(filePath) {
  const match = filePath.match(/^src\/plugin-sdk\/([^/]+)\.ts$/u);
  return match?.[1] ?? "";
}

function patchHasRemovedLines(patch) {
  return /^-(?!-)/mu.test(patch);
}

function patchHasAddedLines(patch) {
  return /^\+(?!\+)/mu.test(patch);
}

function isPublicSurfaceMetadataPath(filePath) {
  return (
    filePath === "docs/.generated/plugin-sdk-api-baseline.sha256" ||
    filePath === "scripts/lib/plugin-sdk-entrypoints.json" ||
    filePath === "scripts/lib/plugin-sdk-entries.mjs" ||
    filePath === "scripts/lib/plugin-sdk-private-local-only-subpaths.json" ||
    filePath === "src/plugin-sdk/entrypoints.ts" ||
    filePath === "package.json" ||
    filePath === "packages/plugin-sdk/package.json"
  );
}

function hasPublicSurfaceMetadataPath(file) {
  return changedFilePaths(file).some(isPublicSurfaceMetadataPath);
}

function hasChangedFilePath(file, filePath) {
  return changedFilePaths(file).includes(filePath);
}

function changesAwayFromPublicSurfaceMetadataPath(file) {
  const currentPath = changedFilePath(file);
  return changedFilePaths(file).some(
    (filePath) => isPublicSurfaceMetadataPath(filePath) && filePath !== currentPath,
  );
}

function classifyDeterministically(triggeredFiles) {
  if (triggeredFiles.length === 0) {
    return {
      classification: "",
      reason: "No plugin SDK impact paths changed.",
      source: "deterministic",
    };
  }

  const paths = triggeredFiles.flatMap(changedFilePaths);
  if (paths.every(isTestOnlyPluginSdkPath)) {
    return {
      classification: "plugin-sdk:test-only",
      reason: "All plugin SDK impact paths are tests or fixtures.",
      source: "deterministic",
    };
  }

  const publicMetadataFiles = triggeredFiles.filter(hasPublicSurfaceMetadataPath);
  if (publicMetadataFiles.some((file) => !hasChangedFilePatch(file))) {
    return {
      classification: "plugin-sdk:breaking-change",
      reason: "Plugin SDK public surface metadata changed without GitHub patch text.",
      source: "deterministic",
    };
  }
  if (publicMetadataFiles.some(changesAwayFromPublicSurfaceMetadataPath)) {
    return {
      classification: "plugin-sdk:breaking-change",
      reason: "Plugin SDK public surface metadata was renamed or removed.",
      source: "deterministic",
    };
  }
  const structuralPublicMetadataFiles = publicMetadataFiles.filter(
    (file) => !hasChangedFilePath(file, "docs/.generated/plugin-sdk-api-baseline.sha256"),
  );
  const privateLocalOnlyMetadataFiles = structuralPublicMetadataFiles.filter((file) =>
    hasChangedFilePath(file, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"),
  );
  if (privateLocalOnlyMetadataFiles.some((file) => patchHasAddedLines(changedFilePatch(file)))) {
    return {
      classification: "plugin-sdk:breaking-change",
      reason: "Plugin SDK public surface metadata made a subpath private.",
      source: "deterministic",
    };
  }
  const normalStructuralPublicMetadataFiles = structuralPublicMetadataFiles.filter(
    (file) => !hasChangedFilePath(file, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"),
  );
  if (
    normalStructuralPublicMetadataFiles.some((file) => patchHasRemovedLines(changedFilePatch(file)))
  ) {
    return {
      classification: "plugin-sdk:breaking-change",
      reason: "Plugin SDK public surface metadata removed lines.",
      source: "deterministic",
    };
  }
  if (
    normalStructuralPublicMetadataFiles.some((file) =>
      patchHasAddedLines(changedFilePatch(file)),
    ) ||
    privateLocalOnlyMetadataFiles.some((file) => patchHasRemovedLines(changedFilePatch(file)))
  ) {
    return {
      classification: "plugin-sdk:additive-api",
      reason: "Plugin SDK public surface metadata changed.",
      source: "deterministic",
    };
  }
  if (
    publicMetadataFiles.some((file) =>
      hasChangedFilePath(file, "docs/.generated/plugin-sdk-api-baseline.sha256"),
    )
  ) {
    return {
      classification: "plugin-sdk:breaking-change",
      reason:
        "Plugin SDK API baseline hash changed without structural metadata proving an additive subpath change.",
      source: "deterministic",
    };
  }

  const publicEntrypointFiles = paths
    .map(pluginSdkEntrypointFromSourcePath)
    .filter((entrypoint) => entrypoint && publicPluginSdkEntrypointSet.has(entrypoint));
  if (publicEntrypointFiles.length > 0) {
    return {
      classification: "plugin-sdk:behavior-change",
      reason: "Public plugin SDK entrypoint implementation changed without public metadata drift.",
      source: "deterministic",
    };
  }

  if (
    paths.some(
      (filePath) =>
        filePath === "src/plugins/types.ts" ||
        filePath === "src/plugins/runtime/types.ts" ||
        filePath.startsWith("src/channels/plugins/") ||
        publicPluginSdkDependencyPaths.has(filePath) ||
        filePath.startsWith("packages/plugin-sdk/"),
    )
  ) {
    return {
      classification: "plugin-sdk:behavior-change",
      reason: "Plugin-facing contract or runtime package path changed.",
      source: "deterministic",
    };
  }

  return {
    classification: "plugin-sdk:private-only",
    reason: "Only private or non-exported plugin SDK support paths changed.",
    source: "deterministic",
  };
}

function classificationFromLabels(labels) {
  return labelNames(labels).map(normalizeClassification).filter(Boolean);
}

function classificationFromBody(body = "") {
  const lines = String(body).split(/\r?\n/u);
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(?:\*\*)?Plugin SDK impact(?:\s+classification)?(?:\*\*)?\s*:\s*(.+?)\s*$/iu,
    );
    if (!match) {
      continue;
    }
    const classification = normalizeClassification(match[1]);
    if (classification) {
      return classification;
    }
  }
  return "";
}

function isClassificationAtLeast(candidate, minimum) {
  return (classificationSeverity.get(candidate) ?? 0) >= (classificationSeverity.get(minimum) ?? 0);
}

function extractMarkerField(marker, name) {
  const match = marker.match(new RegExp(`\\b${name}=([^\\s>]+)`, "iu"));
  return match?.[1] ?? "";
}

function hashTriggeredPaths(triggeredPaths) {
  return createHash("sha256").update(triggeredPaths.join("\n")).digest("hex");
}

function isTrustedClawSweeperComment(comment) {
  const appSlug = String(
    comment?.performed_via_github_app?.slug ?? comment?.performedViaGithubApp?.slug ?? "",
  ).toLowerCase();
  if (appSlug === "clawsweeper") {
    return true;
  }
  const login = String(comment?.user?.login ?? "").toLowerCase();
  const userType = String(comment?.user?.type ?? "");
  return clawsweeperBotLogins.has(login) && userType === "Bot";
}

/** Read a trusted ClawSweeper exact-head impact marker from PR comments. */
export function classificationFromClawSweeperExactHead({
  comments = [],
  pullRequest,
  triggeredPaths = [],
} = {}) {
  const headSha = String(pullRequest?.head?.sha ?? pullRequest?.head_sha ?? "").toLowerCase();
  const baseSha = String(pullRequest?.base?.sha ?? pullRequest?.base_sha ?? "").toLowerCase();
  const pathsHash = hashTriggeredPaths(triggeredPaths);
  if (!/^[0-9a-f]{40}$/iu.test(headSha) || !/^[0-9a-f]{40}$/iu.test(baseSha)) {
    return "";
  }

  for (const comment of [...comments].reverse()) {
    if (!isTrustedClawSweeperComment(comment)) {
      continue;
    }
    const body = String(comment?.body ?? "");
    const markers = body.match(/<!--\s*clawsweeper-plugin-sdk-impact\b[\s\S]*?-->/giu) ?? [];
    for (const marker of [...markers].reverse()) {
      const sha = extractMarkerField(marker, "sha").toLowerCase();
      const base = extractMarkerField(marker, "base").toLowerCase();
      const paths = extractMarkerField(marker, "paths").toLowerCase();
      const classification = normalizeClassification(extractMarkerField(marker, "classification"));
      if (sha === headSha && base === baseSha && paths === pathsHash && classification) {
        return classification;
      }
    }
  }
  return "";
}

/** Resolve the final plugin SDK impact classification for a pull request. */
export function evaluatePluginSdkImpact({ changedFiles = [], comments = [], pullRequest } = {}) {
  const triggeredFiles = changedFiles.filter(isPluginSdkImpactPath);
  const triggeredPaths = [...new Set(triggeredFiles.flatMap(changedFilePaths))].toSorted();
  const deterministic = classifyDeterministically(triggeredFiles);
  if (triggeredFiles.length === 0) {
    return {
      applies: false,
      classification: "",
      classificationSource: "none",
      reason: deterministic.reason,
      triggeredPaths,
    };
  }

  const clawsweeperClassification = classificationFromClawSweeperExactHead({
    comments,
    pullRequest,
    triggeredPaths,
  });
  if (clawsweeperClassification) {
    return {
      applies: true,
      classification: clawsweeperClassification,
      classificationSource: "clawsweeper",
      reason: "Trusted ClawSweeper exact-head marker classified this PR.",
      triggeredPaths,
    };
  }

  const labels = classificationFromLabels(pullRequest?.labels);
  if (labels.length > 1) {
    return {
      applies: true,
      classification: "",
      classificationSource: "label",
      error: `Multiple plugin SDK classification labels are present: ${labels.join(", ")}.`,
      reason: "Exactly one plugin SDK classification label is allowed.",
      triggeredPaths,
    };
  }
  if (labels.length === 1) {
    if (!isClassificationAtLeast(labels[0], deterministic.classification)) {
      return {
        applies: true,
        classification: deterministic.classification,
        classificationSource: deterministic.source,
        error: `Plugin SDK classification label ${labels[0]} is lower than deterministic classification ${deterministic.classification}.`,
        reason: "Plugin SDK impact labels cannot lower deterministic impact classification.",
        triggeredPaths,
      };
    }
    return {
      applies: true,
      classification: labels[0],
      classificationSource: "label",
      reason: "Plugin SDK impact label classified this PR.",
      triggeredPaths,
    };
  }

  const bodyClassification = classificationFromBody(pullRequest?.body ?? "");
  if (bodyClassification) {
    if (!isClassificationAtLeast(bodyClassification, deterministic.classification)) {
      return {
        applies: true,
        classification: deterministic.classification,
        classificationSource: deterministic.source,
        error: `PR body classification ${bodyClassification} is lower than deterministic classification ${deterministic.classification}.`,
        reason: "PR body Plugin SDK impact field cannot lower deterministic impact classification.",
        triggeredPaths,
      };
    }
    return {
      applies: true,
      classification: bodyClassification,
      classificationSource: "body",
      reason: "PR body Plugin SDK impact field classified this PR.",
      triggeredPaths,
    };
  }

  return {
    applies: true,
    classification: deterministic.classification,
    classificationSource: deterministic.source,
    reason: deterministic.reason,
    triggeredPaths,
  };
}

/** Map a plugin SDK impact classification to required merge gates. */
export function pluginSdkImpactRequirements(classification) {
  return {
    maintainerApproval: PLUGIN_SDK_REQUIRES_MAINTAINER_APPROVAL.has(classification),
    rfc: PLUGIN_SDK_REQUIRES_RFC.has(classification),
  };
}

/** Extract openclaw/rfcs pull request numbers linked from PR text. */
export function extractOpenClawRfcPullNumbers(body = "") {
  const numbers = new Set();
  const text = String(body);
  const regex = /https:\/\/github\.com\/openclaw\/rfcs\/pull\/(\d+)\b/giu;
  for (const match of text.matchAll(regex)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].filter(Number.isInteger);
}

/** Build the human-readable failure body shown in the GitHub check annotation. */
export function formatPluginSdkImpactFailure({
  approvalPassed,
  evaluation,
  rfcPassed,
  rfcPullNumbers = [],
} = {}) {
  const requirements = pluginSdkImpactRequirements(evaluation?.classification);
  const lines = [
    `Classification: ${evaluation?.classification || "missing"} (${evaluation?.classificationSource ?? "unknown"})`,
    `Reason: ${evaluation?.reason ?? "No reason provided."}`,
    "Triggered files:",
    ...(evaluation?.triggeredPaths?.length
      ? evaluation.triggeredPaths.map((filePath) => `- ${filePath}`)
      : ["- none"]),
    `Accepted classifications: ${PLUGIN_SDK_CLASSIFICATIONS.join(", ")}`,
    `Maintainer approval required: ${requirements.maintainerApproval ? "yes" : "no"}`,
    `Maintainer approval satisfied: ${approvalPassed ? "yes" : "no"}`,
    `RFC required: ${requirements.rfc ? "yes" : "no"}`,
    `RFC satisfied: ${rfcPassed ? "yes" : "no"}`,
  ];
  if (requirements.rfc) {
    lines.push(`RFC PRs found: ${rfcPullNumbers.length > 0 ? rfcPullNumbers.join(", ") : "none"}`);
  }
  if (evaluation?.error) {
    lines.push(`Classification error: ${evaluation.error}`);
  }
  return lines.join("\n");
}
