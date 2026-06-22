// Plugin Npm Release script supports OpenClaw repository automation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";
import { validateStablePluginSupportManifest } from "../../src/plugins/stable-plugin-support.ts";
import { parseReleaseVersion } from "../openclaw-npm-release-check.ts";
import { collectReleaseVersionFloorErrors, resolveNpmPublishPlan } from "./npm-publish-plan.mjs";

export type PluginPackageJson = {
  name?: string;
  version?: string;
  type?: string;
  private?: boolean;
  repository?:
    | string
    | {
        type?: string;
        url?: string;
      };
  openclaw?: {
    extensions?: string[];
    install?: {
      defaultChoice?: string;
      minHostVersion?: string;
      npmSpec?: string;
    };
    compat?: {
      pluginApi?: string;
      minGatewayVersion?: string;
    };
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
    release?: {
      publishToNpm?: boolean;
    };
  };
};

export type PublishablePluginPackage = {
  extensionId: string;
  packageDir: string;
  packageName: string;
  version: string;
  channel: "stable" | "alpha" | "beta";
  publishTag: "latest" | "alpha" | "beta" | "stable";
  installNpmSpec?: string;
  releaseClass?: PluginReleaseClass;
  releaseSelector?: PluginReleaseSelector;
  stableLine?: string;
  stablePluginSupportSha256?: string;
  targetBranch?: string;
  targetNpmSpec?: string;
  packageAcceptanceRunId?: string;
};

export type PluginReleasePlanItem = PublishablePluginPackage & {
  alreadyPublished: boolean;
};

export type PluginReleasePlan = {
  all: PluginReleasePlanItem[];
  candidates: PluginReleasePlanItem[];
  skippedPublished: PluginReleasePlanItem[];
  packages: string[];
  releaseClass: PluginReleaseClass;
  releaseSelector: PluginReleaseSelector;
  selectionMode: PluginReleaseSelectionMode;
  stableLine?: string;
  stablePluginSupportSha256?: string;
  packageAcceptanceRunId?: string;
};

export type PluginReleaseSelectionMode = "selected" | "all-publishable" | "stable-manifest";
export type PluginReleaseSelector = "daily" | "stable";
export type PluginReleaseClass = "daily" | "stable-base" | "stable-patch";

export type GitRangeSelection = {
  baseRef: string;
  headRef: string;
};

export type ParsedPluginReleaseArgs = {
  selection: string[];
  selectionMode?: PluginReleaseSelectionMode;
  pluginsFlagProvided: boolean;
  baseRef?: string;
  headRef?: string;
  releaseClass?: PluginReleaseClass;
  releaseSelector?: PluginReleaseSelector;
  stableLine?: string;
  stablePluginManifestPath?: string;
  stablePluginManifestSha256?: string;
  packageAcceptanceRunId?: string;
};

export type ResolvedStablePluginSupportManifest = {
  sha256: string;
  stableLine: string;
  baseVersion: string;
  packages: StablePluginSupportPackage[];
};

export type StablePluginSupportPackage = {
  packageName: string;
  pluginId: string;
  packageDir: string;
  targetVersion: string;
  targetNpmSpec: string;
  targetBranch: string;
};

export type PublishablePluginPackageCandidate<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
> = {
  extensionId: string;
  packageDir: string;
  packageJson: TPackageJson;
  readmeText?: string;
};

export const OPENCLAW_PLUGIN_NPM_REPOSITORY_URL = "https://github.com/openclaw/openclaw";

function readPluginPackageJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function collectExtensionPackageJsonCandidates<
  TPackageJson extends PluginPackageJson = PluginPackageJson,
>(rootDir = resolve(".")): PublishablePluginPackageCandidate<TPackageJson>[] {
  const extensionsDir = join(rootDir, "extensions");
  const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const candidates: PublishablePluginPackageCandidate<TPackageJson>[] = [];
  for (const dir of dirs) {
    const packageDir = `extensions/${dir.name}`;
    const absolutePackageDir = join(extensionsDir, dir.name);
    const packageJsonPath = join(absolutePackageDir, "package.json");
    try {
      candidates.push({
        extensionId: dir.name,
        packageDir,
        packageJson: readPluginPackageJson(packageJsonPath) as TPackageJson,
        readmeText: readOptionalTextFile(join(absolutePackageDir, "README.md")),
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

export function resolvePublishablePluginVersion(params: {
  extensionId: string;
  packageJson: Pick<PluginPackageJson, "version">;
  validationErrors: string[];
}): { version: string; parsedVersion: NonNullable<ReturnType<typeof parseReleaseVersion>> } | null {
  const version = params.packageJson.version?.trim() ?? "";
  const parsedVersion = parseReleaseVersion(version);
  if (parsedVersion === null) {
    params.validationErrors.push(
      `${params.extensionId}: package.json version must match YYYY.M.PATCH, YYYY.M.PATCH-N, YYYY.M.PATCH-alpha.N, or YYYY.M.PATCH-beta.N; found "${version}".`,
    );
    return null;
  }
  return { version, parsedVersion };
}

function normalizeGitDiffPath(path: string): string {
  return path.trim().replaceAll("\\", "/");
}

export function parsePluginReleaseSelection(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

export function parsePluginReleaseSelectionMode(
  value: string | undefined,
): PluginReleaseSelectionMode {
  if (value === "selected" || value === "all-publishable" || value === "stable-manifest") {
    return value;
  }

  throw new Error(
    `Unknown selection mode: ${value ?? "<missing>"}. Expected "selected", "all-publishable", or "stable-manifest".`,
  );
}

export function parsePluginReleaseSelector(value: string | undefined): PluginReleaseSelector {
  if (value === undefined || value === "") {
    return "daily";
  }
  if (value === "daily" || value === "stable") {
    return value;
  }
  throw new Error(`Unknown release selector: ${value}. Expected "daily" or "stable".`);
}

export function parsePluginReleaseClass(value: string | undefined): PluginReleaseClass {
  if (value === undefined || value === "") {
    return "daily";
  }
  if (value === "daily" || value === "stable-base" || value === "stable-patch") {
    return value;
  }
  throw new Error(
    `Unknown release class: ${value}. Expected "daily", "stable-base", or "stable-patch".`,
  );
}

export function parsePluginReleaseArgs(argv: string[]): ParsedPluginReleaseArgs {
  let selection: string[] = [];
  let selectionMode: PluginReleaseSelectionMode | undefined;
  let pluginsFlagProvided = false;
  let baseRef: string | undefined;
  let headRef: string | undefined;
  let releaseClass: PluginReleaseClass | undefined;
  let releaseSelector: PluginReleaseSelector | undefined;
  let stableLine: string | undefined;
  let stablePluginManifestPath: string | undefined;
  let stablePluginManifestSha256: string | undefined;
  let packageAcceptanceRunId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--plugins") {
      selection = parsePluginReleaseSelection(readRequiredArgValue(argv, index, arg, true));
      pluginsFlagProvided = true;
      index += 1;
      continue;
    }
    if (arg === "--selection-mode") {
      selectionMode = parsePluginReleaseSelectionMode(readRequiredArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      baseRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--head-ref") {
      headRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--release-selector") {
      releaseSelector = parsePluginReleaseSelector(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--release-class") {
      releaseClass = parsePluginReleaseClass(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--stable-line") {
      stableLine = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--stable-plugin-manifest") {
      stablePluginManifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--stable-plugin-manifest-sha256") {
      stablePluginManifestSha256 = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--package-acceptance-run-id") {
      packageAcceptanceRunId = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  releaseSelector ??= "daily";
  releaseClass ??= releaseSelector === "stable" ? "stable-base" : "daily";

  if (pluginsFlagProvided && selection.length === 0) {
    throw new Error("`--plugins` must include at least one package name.");
  }
  if (selectionMode === "selected" && !pluginsFlagProvided) {
    throw new Error("`--selection-mode selected` requires `--plugins`.");
  }
  if (selectionMode === "all-publishable" && pluginsFlagProvided) {
    throw new Error("`--selection-mode all-publishable` must not be combined with `--plugins`.");
  }
  if (selectionMode === "stable-manifest" && pluginsFlagProvided) {
    throw new Error("`--selection-mode stable-manifest` must not be combined with `--plugins`.");
  }
  if (selection.length > 0 && (baseRef || headRef)) {
    throw new Error("Use either --plugins or --base-ref/--head-ref, not both.");
  }
  if (selectionMode && (baseRef || headRef)) {
    throw new Error("Use either --selection-mode or --base-ref/--head-ref, not both.");
  }
  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    throw new Error("Both --base-ref and --head-ref are required together.");
  }
  if (releaseSelector === "stable" && selectionMode !== "stable-manifest") {
    throw new Error("`--release-selector stable` requires `--selection-mode stable-manifest`.");
  }
  if (selectionMode === "stable-manifest" && releaseSelector !== "stable") {
    throw new Error("`--selection-mode stable-manifest` requires `--release-selector stable`.");
  }
  if (releaseSelector === "daily" && releaseClass !== "daily") {
    throw new Error("`--release-selector daily` requires `--release-class daily`.");
  }
  if (releaseSelector === "stable" && releaseClass === "daily") {
    throw new Error(
      "`--release-selector stable` requires `--release-class stable-base` or `stable-patch`.",
    );
  }
  if (selectionMode === "stable-manifest") {
    if (!stableLine?.trim()) {
      throw new Error("`--selection-mode stable-manifest` requires `--stable-line`.");
    }
    if (!stablePluginManifestPath?.trim()) {
      throw new Error("`--selection-mode stable-manifest` requires `--stable-plugin-manifest`.");
    }
    if (!stablePluginManifestSha256?.trim()) {
      throw new Error(
        "`--selection-mode stable-manifest` requires `--stable-plugin-manifest-sha256`.",
      );
    }
    if (!packageAcceptanceRunId?.trim()) {
      throw new Error("`--selection-mode stable-manifest` requires `--package-acceptance-run-id`.");
    }
  } else if (
    stableLine?.trim() ||
    stablePluginManifestPath?.trim() ||
    stablePluginManifestSha256?.trim() ||
    packageAcceptanceRunId?.trim()
  ) {
    throw new Error("Stable manifest inputs require `--selection-mode stable-manifest`.");
  }

  return {
    selection,
    selectionMode,
    pluginsFlagProvided,
    baseRef,
    headRef,
    releaseClass,
    releaseSelector,
    stableLine,
    stablePluginManifestPath,
    stablePluginManifestSha256,
    packageAcceptanceRunId,
  };
}

function normalizeSha256Digest(value: string, label: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest, with optional sha256: prefix.`);
  }
  return normalized;
}

function requireManifestString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Stable plugin support manifest ${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function resolveStablePluginSupportManifest(params: {
  path: string;
  expectedSha256: string;
  stableLine: string;
}): ResolvedStablePluginSupportManifest {
  const manifestText = readFileSync(params.path, "utf8");
  const validatedManifest = validateStablePluginSupportManifest(JSON.parse(manifestText));
  const manifest = validatedManifest.manifest;
  const sha256 = validatedManifest.stablePluginSupportSha256;
  const expectedSha256 = normalizeSha256Digest(
    params.expectedSha256,
    "--stable-plugin-manifest-sha256",
  );
  if (sha256 !== expectedSha256) {
    throw new Error(
      `Stable plugin support manifest digest mismatch: expected ${expectedSha256}, got ${sha256}.`,
    );
  }

  const stableLine = requireManifestString(manifest.stableLine?.month, "stableLine.month");
  if (stableLine !== params.stableLine.trim()) {
    throw new Error(
      `Stable plugin support manifest stable line mismatch: expected ${params.stableLine}, got ${stableLine}.`,
    );
  }
  const baseVersion = requireManifestString(
    manifest.stableLine?.baseVersion,
    "stableLine.baseVersion",
  );
  const coveredPlugins = manifest.coveredPlugins;
  if (!Array.isArray(coveredPlugins) || coveredPlugins.length === 0) {
    throw new Error("Stable plugin support manifest coveredPlugins must be a non-empty array.");
  }

  const packages = coveredPlugins.map((entry, index): StablePluginSupportPackage => {
    const packageName = requireManifestString(
      entry.packageName,
      `coveredPlugins[${index}].packageName`,
    );
    const targetVersion = requireManifestString(
      entry.targetVersion,
      `coveredPlugins[${index}].targetVersion`,
    );
    const targetNpmSpec = (entry.targetNpmSpec ?? `${packageName}@${targetVersion}`).trim();
    const expectedSpec = `${packageName}@${targetVersion}`;
    if (targetNpmSpec !== expectedSpec) {
      throw new Error(
        `Stable plugin support manifest ${packageName} targetNpmSpec must be ${expectedSpec}; got ${targetNpmSpec}.`,
      );
    }
    const parsedVersion = parseReleaseVersion(targetVersion);
    if (parsedVersion === null || parsedVersion.channel !== "stable") {
      throw new Error(
        `Stable plugin support manifest ${packageName} targetVersion must be a stable YYYY.M.PATCH version.`,
      );
    }
    if (`${parsedVersion.year}.${parsedVersion.month}` !== stableLine) {
      throw new Error(
        `Stable plugin support manifest ${packageName} targetVersion ${targetVersion} is outside stable line ${stableLine}.`,
      );
    }
    return {
      packageName,
      pluginId: requireManifestString(entry.pluginId, `coveredPlugins[${index}].pluginId`),
      packageDir: requireManifestString(entry.packageDir, `coveredPlugins[${index}].packageDir`),
      targetVersion,
      targetNpmSpec,
      targetBranch: requireManifestString(
        entry.targetBranch,
        `coveredPlugins[${index}].targetBranch`,
      ),
    };
  });

  const duplicatePackageNames = packages
    .map((entry) => entry.packageName)
    .filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicatePackageNames.length > 0) {
    throw new Error(
      `Stable plugin support manifest has duplicate packages: ${[...new Set(duplicatePackageNames)].join(", ")}.`,
    );
  }

  return {
    sha256,
    stableLine,
    baseVersion,
    packages: packages.toSorted((left, right) => left.packageName.localeCompare(right.packageName)),
  };
}

function readRequiredArgValue(
  argv: string[],
  index: number,
  flag: string,
  allowBlank = false,
): string {
  const value = argv[index + 1];
  const missingValue =
    value === undefined || value.startsWith("--") || (!allowBlank && value.trim() === "");
  if (missingValue) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function collectPublishablePluginPackageErrors(
  candidate: PublishablePluginPackageCandidate,
): string[] {
  const { packageJson } = candidate;
  const errors: string[] = [];
  const packageName = packageJson.name?.trim() ?? "";
  const packageVersion = packageJson.version?.trim() ?? "";
  const installNpmSpec = normalizeOptionalString(packageJson.openclaw?.install?.npmSpec);
  const repositoryUrl =
    typeof packageJson.repository === "string"
      ? packageJson.repository.trim()
      : (packageJson.repository?.url?.trim() ?? "");
  const extensions = packageJson.openclaw?.extensions ?? [];

  if (!packageName.startsWith("@openclaw/")) {
    errors.push(
      `package name must start with "@openclaw/"; found "${packageName || "<missing>"}".`,
    );
  }
  if (packageJson.private === true) {
    errors.push("package.json private must not be true.");
  }
  if (packageJson.type !== "module") {
    errors.push('package.json type must be "module" so built .js runtime entries load as ESM.');
  }
  if (!candidate.readmeText?.trim()) {
    errors.push("README.md must exist and contain package documentation.");
  }
  if (repositoryUrl !== OPENCLAW_PLUGIN_NPM_REPOSITORY_URL) {
    errors.push(
      `package.json repository.url must be "${OPENCLAW_PLUGIN_NPM_REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing; found "${repositoryUrl || "<missing>"}".`,
    );
  }
  if (!packageVersion) {
    errors.push("package.json version must be non-empty.");
  } else if (parseReleaseVersion(packageVersion) === null) {
    errors.push(
      `package.json version must match YYYY.M.PATCH, YYYY.M.PATCH-N, YYYY.M.PATCH-alpha.N, or YYYY.M.PATCH-beta.N; found "${packageVersion}".`,
    );
  }
  if (!Array.isArray(extensions) || extensions.length === 0) {
    errors.push("openclaw.extensions must contain at least one entry.");
  }
  if (extensions.some((entry) => typeof entry !== "string" || !entry.trim())) {
    errors.push("openclaw.extensions must contain only non-empty strings.");
  }
  if (!installNpmSpec) {
    errors.push("openclaw.install.npmSpec must be a non-empty string for publishable plugins.");
  }
  errors.push(
    ...validateExternalCodePluginPackageJson(packageJson).issues.map((issue) => issue.message),
  );

  return errors;
}

export type PublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
};

export function collectPublishablePluginPackages(
  rootDir = resolve("."),
  filters: PublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  const publishable: PublishablePluginPackage[] = [];
  const validationErrors: string[] = [];
  const selectedExtensionIds = new Set(filters.extensionIds ?? []);
  const selectedPackageNames = new Set(filters.packageNames ?? []);
  const hasSelectedExtensionIds = Array.isArray(filters.extensionIds);
  const hasSelectedPackageNames = Array.isArray(filters.packageNames);

  for (const candidate of collectExtensionPackageJsonCandidates(rootDir)) {
    const { extensionId, packageDir, packageJson } = candidate;
    if (hasSelectedExtensionIds && !selectedExtensionIds.has(extensionId)) {
      continue;
    }
    const packageName = packageJson.name?.trim() ?? "";
    if (hasSelectedPackageNames && !selectedPackageNames.has(packageName)) {
      continue;
    }
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      continue;
    }

    const errors = collectPublishablePluginPackageErrors(candidate);
    if (errors.length > 0) {
      validationErrors.push(...errors.map((error) => `${extensionId}: ${error}`));
      continue;
    }

    const resolvedVersion = resolvePublishablePluginVersion({
      extensionId,
      packageJson,
      validationErrors,
    });
    if (!resolvedVersion) {
      continue;
    }
    const { version, parsedVersion } = resolvedVersion;

    publishable.push({
      extensionId,
      packageDir,
      packageName,
      version,
      channel: parsedVersion.channel,
      publishTag: resolveNpmPublishPlan(version).publishTag,
      installNpmSpec: normalizeOptionalString(packageJson.openclaw?.install?.npmSpec),
    });
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Publishable plugin metadata validation failed:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return publishable.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

export function resolveSelectedPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  selection: string[];
}): PublishablePluginPackage[] {
  if (params.selection.length === 0) {
    return params.plugins;
  }

  const byName = new Map(params.plugins.map((plugin) => [plugin.packageName, plugin]));
  const selected: PublishablePluginPackage[] = [];
  const missing: string[] = [];

  for (const packageName of params.selection) {
    const plugin = byName.get(packageName);
    if (!plugin) {
      missing.push(packageName);
      continue;
    }
    selected.push(plugin);
  }

  if (missing.length > 0) {
    throw new Error(`Unknown or non-publishable plugin package selection: ${missing.join(", ")}.`);
  }

  return selected;
}

export function resolveStableManifestPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  manifest: ResolvedStablePluginSupportManifest;
  releaseClass: PluginReleaseClass;
  releaseSelector: PluginReleaseSelector;
  packageAcceptanceRunId: string;
}): PublishablePluginPackage[] {
  const byName = new Map(params.plugins.map((plugin) => [plugin.packageName, plugin]));
  const resolved: PublishablePluginPackage[] = [];
  const errors: string[] = [];

  for (const manifestPackage of params.manifest.packages) {
    const plugin = byName.get(manifestPackage.packageName);
    if (!plugin) {
      errors.push(
        `${manifestPackage.packageName}: package is not a publishable plugin in this checkout.`,
      );
      continue;
    }
    if (plugin.version !== manifestPackage.targetVersion) {
      errors.push(
        `${manifestPackage.packageName}: package.json version ${plugin.version} does not match stable manifest target ${manifestPackage.targetVersion}.`,
      );
    }
    if (plugin.packageDir !== manifestPackage.packageDir) {
      errors.push(
        `${manifestPackage.packageName}: packageDir ${plugin.packageDir} does not match stable manifest packageDir ${manifestPackage.packageDir}.`,
      );
    }
    if (plugin.channel !== "stable") {
      errors.push(
        `${manifestPackage.packageName}: stable manifest releases require a stable final package version; got ${plugin.version}.`,
      );
    }
    resolved.push({
      ...plugin,
      publishTag: "stable",
      releaseClass: params.releaseClass,
      releaseSelector: params.releaseSelector,
      stableLine: params.manifest.stableLine,
      stablePluginSupportSha256: params.manifest.sha256,
      targetBranch: manifestPackage.targetBranch,
      targetNpmSpec: manifestPackage.targetNpmSpec,
      packageAcceptanceRunId: params.packageAcceptanceRunId,
    });
  }

  if (errors.length > 0) {
    throw new Error(
      `Stable manifest plugin release plan validation failed:\n${errors
        .map((error) => `- ${error}`)
        .join("\n")}`,
    );
  }

  return resolved;
}

export function collectChangedExtensionIdsFromPaths(paths: readonly string[]): string[] {
  const extensionIds = new Set<string>();

  for (const path of paths) {
    const normalized = path.trim().replaceAll("\\", "/");
    const match = /^extensions\/([^/]+)\//.exec(normalized);
    if (match?.[1]) {
      extensionIds.add(match[1]);
    }
  }

  return [...extensionIds].toSorted();
}

function isNullGitRef(ref: string | undefined): boolean {
  return !ref || /^0+$/.test(ref);
}

function assertSafeGitRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed || isNullGitRef(trimmed)) {
    throw new Error(`${label} is required.`);
  }
  if (
    trimmed.startsWith("-") ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n")
  ) {
    throw new Error(`${label} must be a normal git ref or commit SHA.`);
  }
  return trimmed;
}

export function resolveGitCommitSha(rootDir: string, ref: string, label: string): string {
  const safeRef = assertSafeGitRef(ref, label);
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${safeRef}^{commit}`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`${label} is not a valid git commit ref: ${safeRef}`);
  }
}

export function collectChangedPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
  pathspecs: readonly string[];
}): string[] {
  const rootDir = params.rootDir ?? resolve(".");
  const { baseRef, headRef } = params.gitRange;

  if (isNullGitRef(baseRef) || isNullGitRef(headRef)) {
    return [];
  }

  const baseSha = resolveGitCommitSha(rootDir, baseRef, "baseRef");
  const headSha = resolveGitCommitSha(rootDir, headRef, "headRef");

  return execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", baseSha, headSha, "--", ...params.pathspecs],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => normalizeGitDiffPath(path));
}

export function collectChangedExtensionIdsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectChangedExtensionIdsFromPaths(
    collectChangedPathsFromGitRange({
      rootDir: params.rootDir,
      gitRange: params.gitRange,
      pathspecs: ["extensions"],
    }),
  );
}

export function resolveChangedPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  changedExtensionIds: readonly string[];
}): PublishablePluginPackage[] {
  if (params.changedExtensionIds.length === 0) {
    return [];
  }

  const changed = new Set(params.changedExtensionIds);
  return params.plugins.filter((plugin) => changed.has(plugin.extensionId));
}

export function collectPluginReleaseVersionFloorErrors(
  plugins: readonly Pick<PublishablePluginPackage, "packageName" | "version">[],
): string[] {
  return plugins.flatMap((plugin) =>
    collectReleaseVersionFloorErrors(plugin.version).map(
      (error) => `${plugin.packageName}@${plugin.version}: ${error}`,
    ),
  );
}

export function assertPluginReleaseVersionFloors(
  plugins: readonly Pick<PublishablePluginPackage, "packageName" | "version">[],
  label: string,
): void {
  const errors = collectPluginReleaseVersionFloorErrors(plugins);
  if (errors.length === 0) {
    return;
  }
  throw new Error(
    `${label} rejected plugin versions below the release floor:\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}`,
  );
}

function isPluginVersionPublished(packageName: string, version: string): boolean {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-view-"));
  const userconfigPath = join(tempDir, "npmrc");
  writeFileSync(userconfigPath, "");

  try {
    execFileSync(
      "npm",
      ["view", `${packageName}@${version}`, "version", "--userconfig", userconfigPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function collectPluginReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  releaseClass?: PluginReleaseClass;
  releaseSelector?: PluginReleaseSelector;
  stableLine?: string;
  stablePluginManifestPath?: string;
  stablePluginManifestSha256?: string;
  packageAcceptanceRunId?: string;
}): PluginReleasePlan {
  const releaseSelector = params?.releaseSelector ?? "daily";
  const releaseClass =
    params?.releaseClass ?? (releaseSelector === "stable" ? "stable-base" : "daily");
  const selectionMode =
    params?.selectionMode ?? (params?.gitRange ? "selected" : "all-publishable");
  const stableManifest =
    selectionMode === "stable-manifest"
      ? resolveStablePluginSupportManifest({
          path: params?.stablePluginManifestPath ?? "",
          expectedSha256: params?.stablePluginManifestSha256 ?? "",
          stableLine: params?.stableLine ?? "",
        })
      : undefined;
  const changedExtensionIds = params?.gitRange
    ? collectChangedExtensionIdsFromGitRange({
        rootDir: params.rootDir,
        gitRange: params.gitRange,
      })
    : [];
  const allPublishable = collectPublishablePluginPackages(params?.rootDir, {
    extensionIds:
      params?.selectionMode === "all-publishable" ||
      params?.selectionMode === "stable-manifest" ||
      !params?.gitRange
        ? undefined
        : changedExtensionIds,
    packageNames: stableManifest
      ? stableManifest.packages.map((plugin) => plugin.packageName)
      : params?.selection && params.selection.length > 0
        ? params.selection
        : undefined,
  });
  const selectedPublishable =
    params?.selectionMode === "stable-manifest" && stableManifest
      ? resolveStableManifestPublishablePluginPackages({
          plugins: allPublishable,
          manifest: stableManifest,
          releaseClass,
          releaseSelector,
          packageAcceptanceRunId: params?.packageAcceptanceRunId ?? "",
        })
      : params?.selectionMode === "all-publishable"
        ? allPublishable
        : params?.selection && params.selection.length > 0
          ? resolveSelectedPublishablePluginPackages({
              plugins: allPublishable,
              selection: params.selection,
            })
          : params?.gitRange
            ? resolveChangedPublishablePluginPackages({
                plugins: allPublishable,
                changedExtensionIds,
              })
            : allPublishable;

  const explicitPublishSelection =
    params?.selectionMode !== undefined || (params?.selection?.length ?? 0) > 0;
  if (explicitPublishSelection) {
    assertPluginReleaseVersionFloors(selectedPublishable, "Plugin NPM release plan");
  }

  const all = selectedPublishable.map((plugin) =>
    Object.assign({}, plugin, {
      alreadyPublished: isPluginVersionPublished(plugin.packageName, plugin.version),
    }),
  );

  return {
    all,
    candidates: all.filter((plugin) => !plugin.alreadyPublished),
    skippedPublished: all.filter((plugin) => plugin.alreadyPublished),
    packages: all.map((plugin) => `${plugin.packageName}@${plugin.version}`),
    releaseClass,
    releaseSelector,
    selectionMode,
    stableLine: stableManifest?.stableLine,
    stablePluginSupportSha256: stableManifest?.sha256,
    packageAcceptanceRunId: params?.packageAcceptanceRunId,
  };
}
