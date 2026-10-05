import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
import { retryClawHubRead } from "../../src/infra/clawhub-retry.js";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import { readBoundedResponseText } from "./bounded-response.mjs";
import { resolveOpenClawClawHubPackageFamily } from "./clawhub-package-family.mjs";
import {
  classifyClawHubPublication,
  type ClawHubPublicationState,
} from "./clawhub-publication-state.mjs";
import {
  assertPluginReleaseDependencyFreshness,
  collectChangedPathsFromGitRange,
  collectChangedExtensionIdsFromPaths,
  assertPluginReleaseVersionFloors,
  parsePluginReleaseArgs,
  resolveGitCommitSha,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
  type GitRangeSelection,
  type NpmLatestVersionResolver,
  type PluginReleaseSelectionMode,
} from "./plugin-npm-release.ts";
import {
  collectExtensionPackageJsonCandidates,
  hasPluginPublicationSharedAuthorityChanges,
  PLUGIN_PUBLICATION_SHARED_AUTHORITY_PATHS,
} from "./plugin-publication-candidates.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
  type PublishablePluginPackage,
} from "./plugin-publication-collector.ts";

export {
  assertPluginReleaseDependencyFreshness,
  assertPluginReleaseVersionFloors,
  parsePluginReleaseArgs,
};
export type { PublishablePluginPackage } from "./plugin-publication-collector.ts";

type PluginReleasePlanItem = PublishablePluginPackage & {
  publication: ClawHubPublicationState;
  alreadyPublished: boolean;
  artifactName: string;
  family: "" | "bundle-plugin";
};

type PluginReleasePlan = {
  all: PluginReleasePlanItem[];
  warnings: string[];
  candidates: PluginReleasePlanItem[];
  bootstrapCandidates: PluginReleasePlanItem[];
  missingTrustedPublisher: PluginReleasePlanItem[];
  skippedPublished: PluginReleasePlanItem[];
  pendingPublication: PluginReleasePlanItem[];
  failedPublication: PluginReleasePlanItem[];
};

export type ClawHubPackageObservation = {
  publication: ClawHubPublicationState;
  packageExists: boolean;
  alreadyPublished: boolean;
  hasTrustedPublisher: boolean;
  trustedPublisher: {
    provider: string | null;
    repository: string | null;
    workflowFilename: string | null;
    environment: string | null;
  } | null;
};

type PluginReleasePlanItemWithPackageState = PluginReleasePlanItem & {
  packageExists: boolean;
  hasTrustedPublisher: boolean;
};

type ClawHubPublishablePluginPackageFilters = {
  extensionIds?: readonly string[];
  packageNames?: readonly string[];
};

const CLAWHUB_DEFAULT_REGISTRY = "https://clawhub.ai";
const CLAWHUB_REQUEST_TIMEOUT_MS = 30_000;
const CLAWHUB_RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const CLAWHUB_ERROR_BODY_MAX_BYTES = 8 * 1024;
const CLAWHUB_ERROR_BODY_MAX_CHARS = 400;
// All-publishable releases query dozens of packages. Bound registry pressure while
// allowing independent package state reads to leave the core publish critical path quickly.
const CLAWHUB_RELEASE_PLAN_CONCURRENCY = 8;
const OPENCLAW_PLUGIN_CLAWHUB_REPOSITORY = "openclaw/openclaw";
const OPENCLAW_PLUGIN_CLAWHUB_WORKFLOW_FILENAME = "plugin-clawhub-release.yml";
const CLAWHUB_RELEASE_AUTHORITY_PATHS = [
  ".github/workflows/plugin-clawhub-release.yml",
  ".github/actions/setup-node-env",
  "scripts/lib/bounded-command.mjs",
  "scripts/lib/bounded-command.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/plugin-clawhub-release.ts",
  "scripts/lib/clawhub-package-family.mjs",
  "scripts/lib/clawhub-publication-state.mjs",
  "scripts/plugin-clawhub-recovery.mjs",
  "scripts/openclaw-npm-release-check.ts",
  "scripts/clawhub-prepared-artifact.mjs",
  "scripts/plugin-clawhub-publish.sh",
  "scripts/plugin-clawhub-release-check.ts",
  "scripts/plugin-clawhub-release-plan.ts",
] as const;

function getRegistryBaseUrl(explicit?: string) {
  return (
    explicit?.trim() ||
    process.env.CLAWHUB_REGISTRY?.trim() ||
    process.env.CLAWHUB_SITE?.trim() ||
    CLAWHUB_DEFAULT_REGISTRY
  );
}

type ClawHubRequestOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type ClawHubRetryOptions = ClawHubRequestOptions & {
  sleep?: (ms: number) => Promise<void>;
};

async function fetchClawHubRequest(
  url: URL,
  options: ClawHubRequestOptions = {},
): Promise<{
  clearTimeout: () => void;
  response: Response;
  signal: AbortSignal;
  timeoutPromise: Promise<never>;
}> {
  const timeoutMs = options.requestTimeoutMs ?? CLAWHUB_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = Object.assign(
    new Error(`ClawHub request timed out after ${timeoutMs}ms: ${url.href}`),
    { code: "ETIMEDOUT" },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return {
      clearTimeout: () => clearTimeout(timeout),
      response,
      signal: controller.signal,
      timeoutPromise,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function cancelClawHubResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchClawHubRead(
  url: URL,
  options: ClawHubRetryOptions = {},
): Promise<Awaited<ReturnType<typeof fetchClawHubRequest>>> {
  return await retryClawHubRead(
    () =>
      fetchClawHubRequest(url, {
        fetchImpl: options.fetchImpl,
        requestTimeoutMs: options.requestTimeoutMs,
      }),
    {
      disposeRetry: async (request) => {
        await cancelClawHubResponseBody(request.response);
        request.clearTimeout();
      },
      retryRateLimit: true,
      sleep: options.sleep,
    },
  );
}

async function buildClawHubQueryError(
  message: string,
  request: Awaited<ReturnType<typeof fetchClawHubRequest>>,
): Promise<Error> {
  const { response } = request;
  let body: string;
  try {
    body = (
      await readBoundedResponseText(response, message, CLAWHUB_ERROR_BODY_MAX_BYTES, {
        signal: request.signal,
        timeoutPromise: request.timeoutPromise,
      })
    )
      .replace(/\s+/gu, " ")
      .trim();
  } catch {
    body = "";
  }
  if (body.length > CLAWHUB_ERROR_BODY_MAX_CHARS) {
    body = `${truncateUtf16Safe(body, CLAWHUB_ERROR_BODY_MAX_CHARS)}...`;
  }
  const diagnosticHeaders = ["retry-after", "x-request-id", "x-vercel-id", "cf-ray"]
    .map((name) => {
      const value = response.headers.get(name)?.trim();
      return value ? `${name}=${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const detail = [
    body || response.statusText || `HTTP ${response.status}`,
    diagnosticHeaders.length > 0 ? `[${diagnosticHeaders.join("; ")}]` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return new Error(`${message}: ${response.status} ${detail}`);
}

function formatClawHubPackageArtifactName(
  plugin: Pick<PublishablePluginPackage, "packageName" | "version">,
) {
  const safeName = plugin.packageName
    .replace(/^@/u, "")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `clawhub-package-${safeName}-${plugin.version}`;
}

export { resolveOpenClawClawHubPackageFamily };

export function collectClawHubPublishablePluginPackages(
  rootDir = resolve("."),
  filters: ClawHubPublishablePluginPackageFilters = {},
): PublishablePluginPackage[] {
  return collectPublishablePluginPackagesFromCandidates(
    collectExtensionPackageJsonCandidates(rootDir),
    "clawhub",
    filters,
  );
}

export function collectPluginClawHubReleasePathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectChangedPathsFromGitRange({ ...params, pathspecs: ["extensions"] });
}

function collectPluginClawHubRelevantPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  return collectChangedPathsFromGitRange({
    ...params,
    pathspecs: [
      "extensions",
      ...PLUGIN_PUBLICATION_SHARED_AUTHORITY_PATHS,
      ...CLAWHUB_RELEASE_AUTHORITY_PATHS,
    ],
  });
}

function hasSharedClawHubReleaseInputChanges(changedPaths: readonly string[]) {
  return (
    hasPluginPublicationSharedAuthorityChanges(changedPaths) ||
    changedPaths.some((path) =>
      CLAWHUB_RELEASE_AUTHORITY_PATHS.some(
        (authorityPath) => path === authorityPath || path.startsWith(`${authorityPath}/`),
      ),
    )
  );
}

function resolveChangedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  changedPaths: readonly string[];
}): PublishablePluginPackage[] {
  return resolveChangedPublishablePluginPackages({
    plugins: params.plugins,
    changedExtensionIds: collectChangedExtensionIdsFromPaths(params.changedPaths),
  });
}

export function resolveSelectedClawHubPublishablePluginPackages(params: {
  plugins: PublishablePluginPackage[];
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  rootDir?: string;
}): PublishablePluginPackage[] {
  if (params.selectionMode === "all-publishable") {
    return params.plugins;
  }
  if (params.selection && params.selection.length > 0) {
    return resolveSelectedPublishablePluginPackages({
      plugins: params.plugins,
      selection: params.selection,
    });
  }
  if (params.gitRange) {
    const changedPaths = collectPluginClawHubRelevantPathsFromGitRange({
      rootDir: params.rootDir,
      gitRange: params.gitRange,
    });
    if (hasSharedClawHubReleaseInputChanges(changedPaths)) {
      return params.plugins;
    }
    return resolveChangedClawHubPublishablePluginPackages({
      plugins: params.plugins,
      changedPaths,
    });
  }
  return params.plugins;
}

function readPackageManifestAtGitRef(params: {
  rootDir?: string;
  ref: string;
  packageDir: string;
}): PluginPackageJson | null {
  const rootDir = params.rootDir ?? resolve(".");
  const commitSha = resolveGitCommitSha(rootDir, params.ref, "ref");
  try {
    const raw = execFileSync("git", ["show", `${commitSha}:${params.packageDir}/package.json`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(raw) as PluginPackageJson;
  } catch {
    return null;
  }
}

export function collectClawHubVersionGateErrors(params: {
  plugins: PublishablePluginPackage[];
  gitRange: GitRangeSelection;
  rootDir?: string;
}): string[] {
  const changedPaths = collectPluginClawHubReleasePathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: params.gitRange,
  });
  const changedPlugins = resolveChangedClawHubPublishablePluginPackages({
    plugins: params.plugins,
    changedPaths,
  });

  const errors: string[] = [];
  for (const plugin of changedPlugins) {
    const baseManifest = readPackageManifestAtGitRef({
      rootDir: params.rootDir,
      ref: params.gitRange.baseRef,
      packageDir: plugin.packageDir,
    });
    if (baseManifest?.openclaw?.release?.publishToClawHub !== true) {
      continue;
    }
    const baseVersion =
      typeof baseManifest.version === "string" && baseManifest.version.trim()
        ? baseManifest.version.trim()
        : null;
    if (baseVersion === null || baseVersion !== plugin.version) {
      continue;
    }
    errors.push(
      `${plugin.packageName}@${plugin.version}: changed publishable plugin still has the same version in package.json.`,
    );
  }

  return errors;
}

async function readClawHubPublication(
  packageName: string,
  version: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string } = {},
): Promise<ClawHubPublicationState> {
  const resource = `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`;
  const message = `Failed to query ClawHub for ${packageName}@${version}`;
  const body = await readClawHubJson(`${resource}/publication`, message, options, true);
  const publication =
    body === undefined ? null : classifyClawHubPublication(body, { name: packageName, version });
  if (publication) {
    return publication;
  }
  return {
    state: (await clawHubResourceExists(resource, message, options)) ? "published" : "absent",
  };
}

async function clawHubResourceExists(
  resource: string,
  errorMessage: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string },
): Promise<boolean> {
  const url = new URL(resource, getRegistryBaseUrl(options.registryBaseUrl));
  const request = await fetchClawHubRead(url, options);
  const { response } = request;

  try {
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw await buildClawHubQueryError(errorMessage, request);
    }

    return true;
  } finally {
    await cancelClawHubResponseBody(response);
    request.clearTimeout();
  }
}

async function readClawHubJson(
  resource: string,
  message: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string },
  allowMissing = false,
): Promise<unknown> {
  const request = await fetchClawHubRead(
    new URL(resource, getRegistryBaseUrl(options.registryBaseUrl)),
    options,
  );
  try {
    if (allowMissing && request.response.status === 404) {
      return undefined;
    }
    if (!request.response.ok) {
      throw await buildClawHubQueryError(message, request);
    }
    return JSON.parse(
      await readBoundedResponseText(request.response, message, CLAWHUB_RESPONSE_BODY_MAX_BYTES, {
        signal: request.signal,
        timeoutPromise: request.timeoutPromise,
      }),
    );
  } finally {
    await cancelClawHubResponseBody(request.response);
    request.clearTimeout();
  }
}

export async function observeClawHubPackage(
  packageName: string,
  version: string,
  options: ClawHubRetryOptions & { registryBaseUrl?: string } = {},
): Promise<ClawHubPackageObservation> {
  const resource = `/api/v1/packages/${encodeURIComponent(packageName)}`;
  const packageExists = await clawHubResourceExists(
    resource,
    `Failed to query ClawHub package ${packageName}`,
    options,
  );
  if (!packageExists) {
    // Public package metadata hides shells containing only staged releases.
    const publication = await readClawHubPublication(packageName, version, options);
    return {
      packageExists: publication.state !== "absent",
      publication,
      alreadyPublished: publication.state === "published",
      hasTrustedPublisher: false,
      trustedPublisher: null,
    };
  }
  const detail = await readClawHubJson(
    `${resource}/trusted-publisher`,
    `Failed to query ClawHub trusted publisher for ${packageName}`,
    options,
  );
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error(`${packageName}: invalid ClawHub trusted-publisher response.`);
  }
  const raw = Reflect.get(detail, "trustedPublisher");
  let trustedPublisher: ClawHubPackageObservation["trustedPublisher"] = null;
  if (raw != null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${packageName}: invalid ClawHub trusted-publisher observation.`);
    }
    const field = (key: string): string | null => {
      const value = Reflect.get(raw, key);
      if (value == null) {
        return null;
      }
      if (typeof value !== "string" || value.length > 256) {
        throw new Error(`${packageName}: invalid ClawHub trusted-publisher ${key}.`);
      }
      for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 32 || code === 127) {
          throw new Error(`${packageName}: invalid ClawHub trusted-publisher ${key}.`);
        }
      }
      return value;
    };
    trustedPublisher = {
      provider: field("provider"),
      repository: field("repository"),
      workflowFilename: field("workflowFilename"),
      environment: field("environment"),
    };
  }
  const publication = await readClawHubPublication(packageName, version, options);
  return {
    packageExists,
    publication,
    alreadyPublished: publication.state === "published",
    hasTrustedPublisher:
      trustedPublisher !== null &&
      trustedPublisher.repository === OPENCLAW_PLUGIN_CLAWHUB_REPOSITORY &&
      trustedPublisher.workflowFilename === OPENCLAW_PLUGIN_CLAWHUB_WORKFLOW_FILENAME &&
      trustedPublisher.environment === null,
    trustedPublisher,
  };
}

function stripPackageReleaseState(
  item: PluginReleasePlanItemWithPackageState,
): PluginReleasePlanItem {
  const {
    packageExists: _packageExists,
    hasTrustedPublisher: _hasTrustedPublisher,
    ...planItem
  } = item;
  return planItem;
}

export async function collectPluginClawHubReleasePlan(params?: {
  rootDir?: string;
  selection?: string[];
  selectionMode?: PluginReleaseSelectionMode;
  gitRange?: GitRangeSelection;
  registryBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  resolveLatestVersion?: NpmLatestVersionResolver;
  sleep?: (ms: number) => Promise<void>;
  resolvePackageState?: (
    packageName: string,
    version: string,
  ) => Promise<
    Omit<ClawHubPackageObservation, "publication"> & { publication?: ClawHubPublicationState }
  >;
}): Promise<PluginReleasePlan> {
  const rootDir = params?.rootDir;
  const selection = params?.selection ?? [];
  const changedPaths = params?.gitRange
    ? collectPluginClawHubRelevantPathsFromGitRange({
        rootDir,
        gitRange: params.gitRange,
      })
    : [];
  const sharedInputChanged = hasSharedClawHubReleaseInputChanges(changedPaths);
  const extensionIds =
    params?.selectionMode === "all-publishable" || !params?.gitRange || sharedInputChanged
      ? undefined
      : collectChangedExtensionIdsFromPaths(changedPaths);
  const allPublishable = collectClawHubPublishablePluginPackages(rootDir, {
    extensionIds,
    packageNames: selection.length > 0 ? selection : undefined,
  });
  const selectedPublishable = resolveSelectedClawHubPublishablePluginPackages({
    plugins: allPublishable,
    selection,
    selectionMode: params?.selectionMode,
    gitRange: params?.gitRange,
    rootDir,
  });

  const explicitPublishSelection = params?.selectionMode !== undefined || selection.length > 0;
  if (explicitPublishSelection) {
    assertPluginReleaseVersionFloors(selectedPublishable, "Plugin ClawHub release plan");
  }
  const warnings = assertPluginReleaseDependencyFreshness(
    selectedPublishable,
    "Plugin ClawHub release plan",
    params?.resolveLatestVersion,
  );

  const planTasks = selectedPublishable.map((plugin) => async () => {
    const queryOptions = {
      registryBaseUrl: params?.registryBaseUrl,
      fetchImpl: params?.fetchImpl,
      requestTimeoutMs: params?.requestTimeoutMs,
      sleep: params?.sleep,
    };
    const observation = await (
      params?.resolvePackageState ??
      ((name, version) => observeClawHubPackage(name, version, queryOptions))
    )(plugin.packageName, plugin.version);
    // Existing digest-bound full-release receipts predate publication detail.
    const publication: ClawHubPublicationState = observation.publication ?? {
      state: observation.alreadyPublished ? "published" : "absent",
    };
    const { packageExists, hasTrustedPublisher } = observation;

    return {
      extensionId: plugin.extensionId,
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      version: plugin.version,
      channel: plugin.channel,
      publishTag: plugin.publishTag,
      packageExists,
      hasTrustedPublisher,
      alreadyPublished: publication.state === "published",
      publication,
      artifactName: formatClawHubPackageArtifactName(plugin),
      family: resolveOpenClawClawHubPackageFamily(plugin.packageName),
    } satisfies PluginReleasePlanItemWithPackageState;
  });
  const planResult = await runTasksWithConcurrency({
    tasks: planTasks,
    limit: CLAWHUB_RELEASE_PLAN_CONCURRENCY,
    errorMode: "stop",
  });
  if (planResult.hasError) {
    throw planResult.firstError;
  }
  const planned = planResult.results;
  const all = planned.map(stripPackageReleaseState);

  return {
    all,
    warnings,
    candidates: planned
      .filter(
        (plugin) =>
          plugin.packageExists &&
          plugin.hasTrustedPublisher &&
          plugin.publication.state === "absent",
      )
      .map(stripPackageReleaseState),
    bootstrapCandidates: planned
      .filter((plugin) => !plugin.packageExists)
      .map(stripPackageReleaseState),
    missingTrustedPublisher: planned
      .filter(
        (plugin) =>
          plugin.packageExists &&
          !plugin.hasTrustedPublisher &&
          (plugin.publication.state === "absent" || plugin.publication.state === "published"),
      )
      .map(stripPackageReleaseState),
    // Same-run attempts finalize when their parent succeeds. Other-run attempts
    // refuse republish and fail if their parent fails; wait/skip is the only action.
    pendingPublication: planned
      .filter((plugin) => plugin.publication.state === "pending")
      .map(stripPackageReleaseState),
    failedPublication: planned
      .filter((plugin) => plugin.publication.state === "failed")
      .map(stripPackageReleaseState),
    skippedPublished: planned
      .filter((plugin) => plugin.alreadyPublished)
      .map(stripPackageReleaseState),
  };
}
