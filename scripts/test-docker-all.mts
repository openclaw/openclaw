// Docker E2E aggregate scheduler.
// Builds shared Docker images, prepares one OpenClaw npm tarball, assigns lanes
// to bare/functional images, and runs lanes through weighted resource pools.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DEFAULT_E2E_BARE_IMAGE,
  DEFAULT_E2E_FUNCTIONAL_IMAGE,
  DEFAULT_PARALLELISM,
  DEFAULT_PROFILE,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_TAIL_PARALLELISM,
  RELEASE_PATH_PROFILE,
  findLaneByName,
  laneResources,
  laneSummary,
  laneWeight,
  lanesNeedE2eImageKind,
  lanesNeedOpenClawPackage,
  normalizeReleaseProfile,
  parseLaneSelection,
  parseLiveMode,
  parseProfile,
  resolveDockerE2ePlan,
} from "./lib/docker-e2e-plan.mts";
import { liveDockerScriptCommand, type DockerE2eLane } from "./lib/docker-e2e-scenarios.mts";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import {
  createPrepublishPluginRegistryArtifact,
  inspectNpmPackageTarball,
  validatePrepublishPluginRegistryArtifact,
} from "./prepublish-plugin-registry-artifact.mjs";

const SCRIPT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = path.resolve(process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT || SCRIPT_ROOT_DIR);
const HARNESS_ROOT_DIR = path.resolve(
  ROOT_DIR,
  process.env.OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR || SCRIPT_ROOT_DIR,
);
const DEFAULT_FAILURE_TAIL_LINES = 80;
const DEFAULT_LANE_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_LANE_START_STAGGER_MS = 2_000;
const DEFAULT_STATUS_INTERVAL_MS = 30_000;
const DEFAULT_PREFLIGHT_RUN_TIMEOUT_MS = 60_000;
const CLEANUP_SMOKE_NAME = "cleanup-smoke";
export const SHELL_CAPTURE_MAX_CHARS = 1024 * 1024;
export const LOG_TAIL_MAX_BYTES = 1024 * 1024;
const SHELL_TIMEOUT_KILL_GRACE_MS = 10_000;
const SHELL_POST_FORCE_KILL_WAIT_MS = 1_000;
// Private QA subprocess contract. Ordinary lane/CLI failures remain 1; 130/143
// acknowledge joined signal cleanup. Only failed owner cleanup uses 2.
const CLEANUP_FAILURE_EXIT_CODE = 2;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_TIMINGS_FILE = path.join(ROOT_DIR, ".artifacts/docker-tests/lane-timings.json");
const DEFAULT_GITHUB_WORKFLOW = "openclaw-live-and-e2e-checks-reusable.yml";
const CANDIDATE_ENV_KEYS =
  "OPENCLAW_DOCKER_E2E_SELECTED_SHA OPENCLAW_CURRENT_PACKAGE_TGZ OPENCLAW_CURRENT_PACKAGE_VERSION OPENCLAW_CURRENT_PACKAGE_SHA256".split(
    " ",
  );
const REGISTRY_ENV_KEYS =
  "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256".split(
    " ",
  );

type SchedulerLimits = ReturnType<typeof parseSchedulerOptions>;
type PreparedDockerLane = DockerE2eLane & { bundledPluginSweepIds?: string };
type DockerCandidatePlan = ReturnType<typeof resolveDockerE2ePlan>["plan"];

type SchedulerActiveState = {
  count: number;
  resources: Map<string, number>;
  weight: number;
};

type SchedulerLane = Pick<DockerE2eLane, "name"> &
  Partial<Pick<DockerE2eLane, "resources" | "weight">>;

type TimingStore = Awaited<ReturnType<typeof loadTimingStore>>;

type ShellCommandResult = Omit<
  ReturnType<typeof shellCommandSkippedForShutdown>,
  "signal" | "cancelled"
> & {
  cancelled?: true;
  signal: ChildProcess["signalCode"];
};
type ShellCaptureResult = Omit<
  ReturnType<typeof shellCaptureSkippedForShutdown>,
  "signal" | "cancelled"
> & {
  cancelled?: true;
  signal: ChildProcess["signalCode"];
};

type ShellCommandOptions = {
  command: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logFile?: string;
  noOutputTimeoutMs?: number;
  timeoutKillGraceMs?: number;
  timeoutMs?: number;
};

type ShellCaptureOptions = Omit<ShellCommandOptions, "logFile" | "noOutputTimeoutMs"> &
  Required<Pick<ShellCommandOptions, "timeoutMs">>;

type LaneResult = Omit<Awaited<ReturnType<typeof runLane>>, "imageKind"> & {
  imageKind?: DockerE2eLane["e2eImageKind"];
  targetable?: boolean;
};

type RunLaneSummary = Pick<LaneResult, "name" | "status"> & Partial<LaneResult>;

type RunSummary = Record<string, unknown> & {
  failures?: RunLaneSummary[];
  github?: ReturnType<typeof githubRunSummary>;
  images?: { bare?: string; functional?: string };
  lanes?: RunLaneSummary[];
  status?: string;
};

type LanePoolOptions = SchedulerLimits & {
  failFast: boolean;
  poolLabel: string;
  startStaggerMs: number;
  statusIntervalMs: number;
  timeoutMs: number;
};

type ForegroundEntry = {
  command: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  phaseDetails?: Record<string, unknown>;
  phases?: Array<Record<string, unknown>>;
};

type ShutdownSignal = "SIGINT" | "SIGKILL" | "SIGTERM";

const IS_MAIN = (() => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    // Node resolves ESM URLs through symlinks, but argv keeps the invoked path.
    return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

function dockerAllUsage() {
  return [
    "Usage: node scripts/test-docker-all.mjs [--plan-json | --prepare-only=<manifest> | --prepare-plugin-registry]",
    "",
    "Options:",
    "  --plan-json              Print the resolved Docker E2E plan as JSON and exit.",
    "  --prepare-only=<manifest> Prepare one immutable candidate manifest and exit.",
    "  --prepare-plugin-registry Prepare only the selected lanes' plugin registry.",
    "  -h, --help               Show this help.",
    "",
    "Lane selection and scheduler settings are configured with OPENCLAW_DOCKER_ALL_* env vars.",
  ].join("\n");
}

export function parseDockerAllCliArgs(argv: readonly string[]) {
  const options: {
    help: boolean;
    planJson: boolean;
    prepareOnly?: string;
    preparePluginRegistry: boolean;
  } = {
    help: false,
    planJson: false,
    preparePluginRegistry: false,
  };
  for (const arg of argv) {
    if (arg === "--plan-json") {
      options.planJson = true;
    } else if (arg.startsWith("--prepare-only=")) {
      options.prepareOnly = arg.slice("--prepare-only=".length);
      if (!options.prepareOnly) {
        throw new Error(`--prepare-only requires a manifest path\n\n${dockerAllUsage()}`);
      }
    } else if (arg === "--prepare-plugin-registry") {
      options.preparePluginRegistry = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${dockerAllUsage()}`);
    }
  }
  assert(
    [options.planJson, Boolean(options.prepareOnly), options.preparePluginRegistry].filter(Boolean)
      .length <= 1,
    "conflicting plan/prep options",
  );
  return options;
}

let cliOptions: ReturnType<typeof parseDockerAllCliArgs> = {
  help: false,
  planJson: false,
  preparePluginRegistry: false,
};
if (IS_MAIN) {
  try {
    cliOptions = parseDockerAllCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (cliOptions.help) {
    console.log(dockerAllUsage());
    process.exit(0);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a non-negative integer. Got: ${JSON.stringify(raw)}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseBool(raw: string | undefined, fallback: boolean) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return !/^(?:0|false|no)$/i.test(raw);
}

function normalizeReleaseProfileEnv(raw: string | undefined) {
  const profile = raw?.trim();
  if (!profile) {
    return normalizeReleaseProfile(undefined);
  }
  if (profile === "minimum" || profile === "beta" || profile === "stable" || profile === "full") {
    return normalizeReleaseProfile(profile);
  }
  throw new Error(
    `release profile must be one of: beta, stable, full. Got: ${JSON.stringify(raw)}`,
  );
}

function numericTimerValueMs(valueMs: unknown) {
  const value = Number(valueMs);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function resolveDockerSchedulerTimeoutMs(
  valueMs: unknown,
  fallbackMs: unknown = MAX_TIMER_TIMEOUT_MS,
) {
  const value = numericTimerValueMs(valueMs) ?? numericTimerValueMs(fallbackMs);
  return Math.min(Math.max(value ?? MAX_TIMER_TIMEOUT_MS, 1), MAX_TIMER_TIMEOUT_MS);
}

function resolveOptionalTimerTimeoutMs(valueMs: unknown) {
  const value = numericTimerValueMs(valueMs);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return resolveDockerSchedulerTimeoutMs(value);
}

function resourceLimitsSummary(resourceLimits: Record<string, number>) {
  return Object.entries(resourceLimits)
    .map(([resource, limit]) => `${resource}=${String(limit)}`)
    .join(" ");
}

export function describeDockerSchedulerLimits(parallelism: number, options: SchedulerLimits) {
  return `parallelism=${parallelism} weightLimit=${options.weightLimit} resources=${resourceLimitsSummary(
    options.resourceLimits,
  )}`;
}

function parseSchedulerOptions(env: NodeJS.ProcessEnv, parallelism: number) {
  const weightLimit = parsePositiveInt(
    env.OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT,
    parallelism,
    "OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT",
  );
  const resourceLimits: Record<string, number> = {};
  for (const [resource, fallback] of Object.entries(DEFAULT_RESOURCE_LIMITS)) {
    const envName = `OPENCLAW_DOCKER_ALL_${resource.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_LIMIT`;
    resourceLimits[resource] = parsePositiveInt(
      env[envName],
      Math.min(parallelism, fallback),
      envName,
    );
  }
  return {
    resourceLimits,
    weightLimit,
  };
}

export function canStartSchedulerLane(
  candidate: SchedulerLane,
  active: SchedulerActiveState,
  parallelism: number,
  options: SchedulerLimits,
) {
  const weight = Math.max(1, candidate.weight ?? 1);
  if (active.count >= parallelism) {
    return false;
  }

  const exceedsWeightLimit = active.weight + weight > options.weightLimit;
  const resources = [...new Set(["docker", ...(candidate.resources ?? [])])];
  const exceedsResourceLimit = resources.some((resource) => {
    const limit = options.resourceLimits[resource] ?? options.weightLimit;
    const current = active.resources.get(resource) ?? 0;
    return current + weight > limit;
  });

  if (!exceedsWeightLimit && !exceedsResourceLimit) {
    return true;
  }

  return active.count === 0;
}

function timingSeconds(timings: Record<string, unknown>, poolLane: DockerE2eLane) {
  const timing = timings[poolLane.name];
  const fromStore = isRecord(timing) ? timing.durationSeconds : undefined;
  if (typeof fromStore === "number" && Number.isFinite(fromStore) && fromStore > 0) {
    return fromStore;
  }
  return poolLane.estimateSeconds ?? 0;
}

function orderLanes(poolLanes: DockerE2eLane[], timingStore?: unknown) {
  const timings = isRecord(timingStore) && isRecord(timingStore.lanes) ? timingStore.lanes : {};
  return poolLanes
    .map((poolLane, index) => ({
      index,
      poolLane,
      seconds: timingSeconds(timings, poolLane),
    }))
    .toSorted((a, b) => b.seconds - a.seconds || a.index - b.index)
    .map(({ poolLane }) => poolLane);
}

function utcStampForPath() {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\..*$/, "Z");
}

function utcStamp() {
  return new Date().toISOString().replace(/\..*$/, "Z");
}

function appendExtension(env: NodeJS.ProcessEnv, extension: string) {
  const current = env.OPENCLAW_DOCKER_BUILD_EXTENSIONS ?? env.OPENCLAW_EXTENSIONS ?? "";
  const tokens = current.split(/\s+/).filter(Boolean);
  if (!tokens.includes(extension)) {
    tokens.push(extension);
  }
  env.OPENCLAW_DOCKER_BUILD_EXTENSIONS = tokens.join(" ");
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...extra,
  };
  const pathEntries = [
    env.PATH,
    env.PNPM_HOME,
    env.npm_execpath ? path.dirname(env.npm_execpath) : undefined,
    path.dirname(process.execPath),
  ]
    .flatMap((entry) => (entry ? entry.split(path.delimiter) : []))
    .filter(Boolean);
  env.PATH = [...new Set(pathEntries)].join(path.delimiter);
  return env;
}

function gitOutput(repoRoot: string, args: string[]) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function rootPackageVersion(repoRoot: string) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string;
}

function readCompleteTuple(env: NodeJS.ProcessEnv, keys: readonly string[], label: string) {
  const entries = keys.flatMap((key) => (env[key] ? [[key, env[key]]] : []));
  const complete = entries.length === keys.length;
  assert(!entries.length || complete, `${label} fields must be complete`);
  return complete ? Object.fromEntries(entries) : undefined;
}

function validateRegistryEnvironment(baseEnv: NodeJS.ProcessEnv, plan: DockerCandidatePlan) {
  validatePrepublishPluginRegistryArtifact({
    artifactDir: baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR!,
    expectedCandidateVersion: baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION!,
    expectedManifestSha256: baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256!,
    expectedSourceSha: baseEnv.OPENCLAW_DOCKER_E2E_SELECTED_SHA!,
    requiredPackages: plan.requiredPrepublishPluginPackages,
  });
}

export function validateDockerCandidateEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  plan: DockerCandidatePlan,
  repoRoot = ROOT_DIR,
) {
  const strictCandidate = CANDIDATE_ENV_KEYS.slice(2).some((key) => baseEnv[key]);
  if (!strictCandidate || !plan.needs.package) {
    baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ &&= path.resolve(baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ);
    const registryDir = baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR;
    if (!registryDir) {
      delete baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR;
      return;
    }
    baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR = path.resolve(registryDir);
    validateRegistryEnvironment(baseEnv, plan);
    return;
  }
  const candidate = readCompleteTuple(baseEnv, CANDIDATE_ENV_KEYS, "Docker candidate")!;
  const registry = readCompleteTuple(baseEnv, REGISTRY_ENV_KEYS, "Docker candidate registry");
  const packagePath = candidate.OPENCLAW_CURRENT_PACKAGE_TGZ;
  if (
    !path.isAbsolute(packagePath) ||
    gitOutput(repoRoot, ["rev-parse", "HEAD"]) !== candidate.OPENCLAW_DOCKER_E2E_SELECTED_SHA
  ) {
    throw new Error("Docker candidate path must be absolute and selected SHA must equal HEAD");
  }
  const packed = inspectNpmPackageTarball(packagePath);
  if (
    packed.packageJson.name !== "openclaw" ||
    packed.packageJson.version !== rootPackageVersion(repoRoot) ||
    packed.packageJson.version !== candidate.OPENCLAW_CURRENT_PACKAGE_VERSION ||
    packed.sha256 !== candidate.OPENCLAW_CURRENT_PACKAGE_SHA256
  ) {
    throw new Error("Docker candidate package identity differs from the immutable tuple");
  }
  if (registry) {
    const registryDir = registry.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR;
    assert(path.isAbsolute(registryDir), "Docker candidate registry path must be absolute");
    validateRegistryEnvironment(baseEnv, plan);
  } else if (plan.needs.prepublishPluginRegistry) {
    throw new Error("Docker plan requires a prepublish plugin registry tuple");
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function maybeGhcrImage(value: unknown) {
  return typeof value === "string" && value.startsWith("ghcr.io/") ? value : "";
}

export function githubWorkflowRerunCommand(
  laneNames: readonly string[],
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const workflowRef = env.OPENCLAW_DOCKER_E2E_WORKFLOW_REF || undefined;
  const releasePath = env.OPENCLAW_DOCKER_ALL_PROFILE === RELEASE_PATH_PROFILE;
  const allowUnreleasedChangelog = env.OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG === "true";
  const bareImage = maybeGhcrImage(env.OPENCLAW_DOCKER_E2E_BARE_IMAGE);
  const functionalImage = maybeGhcrImage(env.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE);
  const fields = [
    "gh workflow run",
    shellQuote(env.OPENCLAW_DOCKER_E2E_WORKFLOW || DEFAULT_GITHUB_WORKFLOW),
    ...(workflowRef ? ["--ref", shellQuote(workflowRef)] : []),
    "-f",
    `ref=${shellQuote(ref)}`,
    "-f",
    "include_repo_e2e=false",
    "-f",
    `include_release_path_suites=${releasePath ? "true" : "false"}`,
    "-f",
    "include_openwebui=false",
    "-f",
    `docker_lanes=${shellQuote(laneNames.join(" "))}`,
    "-f",
    "include_live_suites=false",
    "-f",
    "live_models_only=false",
  ];
  if (allowUnreleasedChangelog) {
    fields.push("-f", "allow_unreleased_changelog=true");
  }
  if (env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baseline=${shellQuote(env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC)}`,
    );
  }
  if (env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baselines=${shellQuote(env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS)}`,
    );
  }
  if (env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS) {
    fields.push(
      "-f",
      `published_upgrade_survivor_scenarios=${shellQuote(env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS)}`,
    );
  }
  if (bareImage) {
    fields.push("-f", `docker_e2e_bare_image=${shellQuote(bareImage)}`);
  }
  if (functionalImage) {
    fields.push("-f", `docker_e2e_functional_image=${shellQuote(functionalImage)}`);
  }
  if (bareImage || functionalImage) {
    fields.push("-f", "shared_image_policy=existing-only");
  }
  return fields.join(" ");
}

export function buildLaneRerunCommand(name: string, baseEnv: NodeJS.ProcessEnv) {
  const poolLane = findLaneByName(name);
  const build = name.startsWith("live-") ? "1" : "0";
  const image = poolLane ? e2eImageForLane(poolLane, baseEnv) : baseEnv.OPENCLAW_DOCKER_E2E_IMAGE;
  const env: Array<readonly [string, string | undefined]> = [
    ["OPENCLAW_DOCKER_ALL_LANES", name],
    ["OPENCLAW_DOCKER_ALL_BUILD", build],
    ["OPENCLAW_DOCKER_ALL_PREFLIGHT", "0"],
    ["OPENCLAW_SKIP_DOCKER_BUILD", "1"],
    ["OPENCLAW_DOCKER_E2E_IMAGE", image || DEFAULT_E2E_FUNCTIONAL_IMAGE],
    ["OPENCLAW_DOCKER_E2E_BARE_IMAGE", baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE],
    ["OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE", baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE],
    ["OPENCLAW_DOCKER_E2E_REPO_ROOT", baseEnv.OPENCLAW_DOCKER_E2E_REPO_ROOT],
    ["OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR", baseEnv.OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR],
    ...CANDIDATE_ENV_KEYS.map((key) => [key, baseEnv[key]] as const),
    ...REGISTRY_ENV_KEYS.map((key) => [key, baseEnv[key]] as const),
    ["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC],
    ["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS],
    ["OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS],
  ];
  if (baseEnv.OPENCLAW_DOCKER_ALL_PNPM_COMMAND) {
    env.push(["OPENCLAW_DOCKER_ALL_PNPM_COMMAND", baseEnv.OPENCLAW_DOCKER_ALL_PNPM_COMMAND]);
  }
  const envPrefix = env
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1] !== "",
    )
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return prepareHarnessCommand("pnpm test:docker:all", baseEnv, envPrefix);
}

function prepareHarnessCommand(command: string, env: NodeJS.ProcessEnv, envPrefix = "") {
  if (!/(^|\s)pnpm(?=\s)/.test(command)) {
    return command;
  }
  const pinnedPnpm = env.OPENCLAW_DOCKER_ALL_PNPM_COMMAND?.trim();
  const executable = pinnedPnpm?.includes("/") ? path.resolve(ROOT_DIR, pinnedPnpm) : pinnedPnpm;
  const invocation = command.replace(
    /(^|\s)pnpm(?=\s)/g,
    (_, prefix: string) => `${prefix}${executable ? shellQuote(executable) : "pnpm"}`,
  );
  // Quoted environment values may themselves contain " pnpm ". Substitute only
  // the catalog invocation, then add the already-quoted rerun assignments.
  const prepared = envPrefix ? `${envPrefix} ${invocation}` : invocation;
  // Corepack selects the package-manager pin before pnpm parses --dir. Enter
  // the harness first; candidate paths have already been prepared as absolute.
  return HARNESS_ROOT_DIR === ROOT_DIR
    ? prepared
    : `(cd ${shellQuote(HARNESS_ROOT_DIR)} && ${prepared})`;
}

async function loadTimingStore(file: string, enabled: boolean) {
  if (!enabled) {
    return { enabled: false, file, lanes: {}, version: 1 };
  }
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) {
    return { enabled: true, file, lanes: {}, version: 1 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      enabled: true,
      file,
      lanes: isRecord(parsed) && isRecord(parsed.lanes) ? parsed.lanes : {},
      version: 1,
    };
  } catch (error) {
    console.warn(
      `WARN: ignoring unreadable Docker lane timings ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { enabled: true, file, lanes: {}, version: 1 };
  }
}

async function writeTimingStore(timingStore: TimingStore, results: LaneResult[]) {
  if (!timingStore.enabled || results.length === 0) {
    return;
  }
  const next = {
    lanes: { ...timingStore.lanes },
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  for (const result of results) {
    if (!result || typeof result.elapsedSeconds !== "number") {
      continue;
    }
    next.lanes[result.name] = {
      durationSeconds: result.elapsedSeconds,
      status: result.status,
      timedOut: result.timedOut,
      updatedAt: new Date().toISOString(),
    };
  }
  await mkdir(path.dirname(timingStore.file), { recursive: true }).catch(recordPublicationFailure);
  await fs.promises
    .writeFile(timingStore.file, `${JSON.stringify(next, null, 2)}\n`)
    .catch(recordPublicationFailure);
  timingStore.lanes = next.lanes;
  console.log(`==> Docker lane timings: ${timingStore.file}`);
}

function githubRunSummary(env: NodeJS.ProcessEnv) {
  return {
    ref: env.GITHUB_REF_NAME || undefined,
    repository: env.GITHUB_REPOSITORY || undefined,
    runId: env.GITHUB_RUN_ID || undefined,
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined,
    selectedSha: env.OPENCLAW_DOCKER_E2E_SELECTED_SHA || undefined,
    sha: env.GITHUB_SHA || undefined,
    workflow: env.GITHUB_WORKFLOW || undefined,
  };
}

function runSummaryPayload(summary: RunSummary, env: NodeJS.ProcessEnv) {
  return {
    ...summary,
    // Summary reruns do not carry failure-index commands, so preserve this exact package intent.
    allowUnreleasedChangelog:
      env.OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG === "true" ? true : undefined,
    packageArtifactName: env.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME || undefined,
    finishedAt: new Date().toISOString(),
    github: githubRunSummary(env),
    version: 1,
  };
}

export async function writeRunSummary(
  logDir: string,
  summary: RunSummary,
  env: NodeJS.ProcessEnv = process.env,
) {
  const file = path.join(logDir, "summary.json");
  const payload = runSummaryPayload(summary, env);
  // Keep raw evidence even when the required failure index cannot be published.
  await fs.promises
    .writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)
    .catch(recordPublicationFailure);
  await writeFailureIndex(logDir, payload, env).catch(recordPublicationFailure);
  console.log(`==> Docker run summary: ${file}`);
}

async function commitJoinedSummary(
  logDir: string,
  summary: () => RunSummary,
  env: NodeJS.ProcessEnv,
) {
  const temporary = path.join(logDir, `.summary-${randomUUID()}.tmp`);
  const payload = { ...runSummaryPayload(summary(), env), cleanup: { joined: true } };
  let owned = false;
  let failure: { error: unknown } | undefined;
  try {
    const handle = await open(temporary, "wx");
    owned = true;
    const errors: unknown[] = [];
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`).catch((error: unknown) => {
      errors.push(error);
    });
    await handle.close().catch((error: unknown) => {
      errors.push(error);
    });
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Docker summary staging failed", { cause: errors[0] });
    }
    await activeChildrenShutdownPromise;
    if (!requiredPublicationFailed && cleanupFailures.length === 0 && activeChildren.size === 0) {
      // Include every handled signal before promotion without yielding between the
      // final verdict and rename. Later signals affect exit, not the committed report.
      const latest = runSummaryPayload(summary(), env);
      fs.writeFileSync(
        path.join(logDir, "failures.json"),
        `${JSON.stringify(failureIndexPayload(latest, env), null, 2)}\n`,
      );
      if (latest.status !== payload.status) {
        fs.writeFileSync(
          temporary,
          `${JSON.stringify({ ...latest, cleanup: { joined: true } }, null, 2)}\n`,
        );
      }
      fs.renameSync(temporary, path.join(logDir, "summary.json"));
      owned = false;
    }
  } catch (error) {
    requiredPublicationFailed = true;
    failure = { error };
  }
  if (owned) {
    try {
      await fs.promises.rm(temporary, { force: true });
    } catch (cleanupError) {
      requiredPublicationFailed = true;
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, cleanupError],
              "Docker summary staging cleanup failed",
              { cause: failure.error },
            )
          : cleanupError,
      };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

function failureIndexPayload(summary: RunSummary, env: NodeJS.ProcessEnv) {
  const ref =
    summary.github?.selectedSha ||
    env.OPENCLAW_DOCKER_E2E_SELECTED_SHA ||
    summary.github?.sha ||
    summary.github?.ref ||
    env.GITHUB_SHA ||
    "HEAD";
  const failures = Array.isArray(summary.failures)
    ? summary.failures
    : (summary.lanes ?? []).filter((lane) => lane.status !== 0);
  const workflowRerunFailures = failures.filter((failure) => failure.targetable !== false);
  const lanes = failures.map((failure) => ({
    ghWorkflowCommand:
      failure.targetable === false
        ? undefined
        : githubWorkflowRerunCommand([failure.name], ref, env),
    image: failure.image,
    imageKind: failure.imageKind,
    lane: failure.name,
    logFile: failure.logFile,
    name: failure.name,
    noOutputTimedOut: failure.noOutputTimedOut,
    rerunCommand: failure.rerunCommand,
    status: failure.status,
    targetable: failure.targetable,
    timedOut: failure.timedOut,
  }));
  return {
    combinedGhWorkflowCommand:
      workflowRerunFailures.length > 0
        ? githubWorkflowRerunCommand(
            workflowRerunFailures.map((failure) => failure.name),
            ref,
            env,
          )
        : undefined,
    generatedAt: new Date().toISOString(),
    lanes,
    note: "Targeted GitHub reruns repack the exact selected ref and reuse only GHCR-backed shared images when the generated command includes docker_e2e_*_image inputs.",
    images: summary.images,
    packageArtifactName: env.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME || undefined,
    ref,
    runUrl: summary.github?.runUrl,
    version: 1,
    workflow: env.OPENCLAW_DOCKER_E2E_WORKFLOW || DEFAULT_GITHUB_WORKFLOW,
  };
}

async function writeFailureIndex(logDir: string, summary: RunSummary, env: NodeJS.ProcessEnv) {
  await fs.promises.writeFile(
    path.join(logDir, "failures.json"),
    `${JSON.stringify(failureIndexPayload(summary, env), null, 2)}\n`,
  );
}

function phaseElapsedSeconds(startedAtMs: number) {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

function laneAttempt(
  attempt: number,
  startedAtMs: number,
  result: Pick<ShellCommandResult, "noOutputTimedOut" | "status" | "timedOut">,
) {
  return {
    attempt,
    elapsedSeconds: phaseElapsedSeconds(startedAtMs),
    finishedAt: new Date().toISOString(),
    noOutputTimedOut: result.noOutputTimedOut,
    startedAt: new Date(startedAtMs).toISOString(),
    status: result.status,
    timedOut: result.timedOut,
  };
}

function cleanupSmokeResult(
  baseEnv: NodeJS.ProcessEnv,
  logFile: string,
  command: string,
  startedAtMs: number,
  result: Pick<ShellCommandResult, "cancelled" | "noOutputTimedOut" | "status" | "timedOut">,
) {
  return {
    ...(result.cancelled ? { cancelled: true as const } : {}),
    command,
    attempts: [laneAttempt(1, startedAtMs, result)],
    elapsedSeconds: phaseElapsedSeconds(startedAtMs),
    finishedAt: new Date().toISOString(),
    image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
    logFile,
    name: CLEANUP_SMOKE_NAME,
    noOutputTimedOut: result.noOutputTimedOut,
    rerunCommand: command,
    startedAt: new Date(startedAtMs).toISOString(),
    status: result.status,
    targetable: false,
    timedOut: result.timedOut,
  };
}

async function runPhase<T>(
  phases: Array<Record<string, unknown>>,
  name: string,
  details: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let status: "failed" | "passed" = "passed";
  let errorMessage: string | undefined;
  try {
    const result = await fn();
    return result;
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const phase = {
      ...details,
      name,
      startedAt,
      status,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
      elapsedSeconds: phaseElapsedSeconds(startedAtMs),
      finishedAt: new Date().toISOString(),
    };
    phases.push(phase);
    console.log(`==> Phase ${phase.status}: ${name} ${phase.elapsedSeconds}s`);
  }
}

function printLaneManifest(
  label: string,
  poolLanes: DockerE2eLane[],
  timingStore: TimingStore,
): void {
  console.log(`==> ${label} lanes (${poolLanes.length})`);
  for (const [index, poolLane] of poolLanes.entries()) {
    const seconds = timingSeconds(timingStore.lanes, poolLane);
    const estimate = seconds > 0 ? ` last=${Math.round(seconds)}s` : "";
    console.log(`  ${index + 1}. ${laneSummary(poolLane)}${estimate}`);
  }
}

export function dockerPreflightContainerNames(raw: string): string[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const name = line.trim().split(/\s+/, 1)[0];
    return name &&
      /^(?:openclaw-[a-z0-9-]+-e2e-\d+|openclaw-openwebui(?:-gateway)?-\d+)$/u.test(name)
      ? [name]
      : [];
  });
}

export function resolveDockerPreflightPlatform(arch: NodeJS.Architecture = process.arch) {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

export function dockerPreflightSmokeCommand(arch: NodeJS.Architecture = process.arch) {
  const platform = resolveDockerPreflightPlatform(arch);
  return `docker run --rm --platform ${shellQuote(platform)} alpine:3.24 true`;
}

export function runShellCommand({
  command,
  env,
  label,
  logFile,
  timeoutMs,
  noOutputTimeoutMs,
  timeoutKillGraceMs = SHELL_TIMEOUT_KILL_GRACE_MS,
}: ShellCommandOptions) {
  if (activeChildrenShutdownPromise) {
    return activeChildrenShutdownPromise.then(() => shellCommandSkippedForShutdown());
  }
  return new Promise<ShellCommandResult>((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(timeoutMs);
    const resolvedNoOutputTimeoutMs = resolveOptionalTimerTimeoutMs(noOutputTimeoutMs);
    const resolvedTimeoutKillGraceMs = resolveDockerSchedulerTimeoutMs(
      timeoutKillGraceMs,
      SHELL_TIMEOUT_KILL_GRACE_MS,
    );
    const pipeOutput = Boolean(logFile || resolvedNoOutputTimeoutMs);
    const child = spawn("bash", ["-c", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
      env,
      stdio: pipeOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChildren.set(child, resolvedTimeoutKillGraceMs);
    let timedOut = false;
    let noOutputTimedOut = false;
    let cancelled: boolean | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killAt: number | undefined;
    const stream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : undefined;
    const logErrors: unknown[] = [];
    const recordLogError = (error: unknown) => {
      requiredPublicationFailed = true;
      if (!logErrors.includes(error)) {
        logErrors.push(error);
      }
      // Failed required output closes admission now; command ownership still joins the log.
      void (activeChildrenShutdownPromise ?? shutdownActiveChildren("SIGTERM", 1)).catch(
        () => undefined,
      );
    };
    stream?.on("error", recordLogError);
    // error:false waits for the native fs close callback even after a write
    // failure. Observe rejection now; an open error can precede child exit.
    const logSettled = stream
      ? finished(stream, { error: false, cleanup: true }).catch(recordLogError)
      : undefined;
    const writeLog = (chunk: string | Uint8Array) => {
      if (stream && !stream.destroyed && !stream.errored) {
        stream.write(chunk, (error) => {
          if (error) {
            recordLogError(error);
          }
        });
      }
    };
    let noOutputTimer: ReturnType<typeof setTimeout> | undefined;
    // Exit can precede stdio/group drain; later signals cannot rewrite its origin.
    child.once("exit", () => {
      cancelled ??= Boolean(activeChildrenShutdownPromise);
    });
    const terminateForTimeout = (message: string, options: { noOutput?: boolean } = {}) => {
      if (timedOut) {
        return;
      }
      cancelled ??= Boolean(activeChildrenShutdownPromise);
      timedOut = true;
      noOutputTimedOut = options.noOutput === true;
      if (stream) {
        writeLog(`\n==> [${label}] ${message}; sending SIGTERM\n`);
      } else {
        console.error(`==> [${label}] ${message}; sending SIGTERM`);
      }
      terminateChild(child, "SIGTERM");
      killAt = Date.now() + resolvedTimeoutKillGraceMs;
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), resolvedTimeoutKillGraceMs);
      killTimer.unref?.();
    };
    const resetNoOutputTimer = () => {
      if (!resolvedNoOutputTimeoutMs || timedOut) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        terminateForTimeout(`no output for ${resolvedNoOutputTimeoutMs}ms`, { noOutput: true });
      }, resolvedNoOutputTimeoutMs);
      noOutputTimer.unref?.();
    };
    const timeoutTimer =
      resolvedTimeoutMs !== undefined
        ? setTimeout(() => {
            terminateForTimeout(`timeout after ${resolvedTimeoutMs}ms`);
          }, resolvedTimeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    if (stream) {
      writeLog(`==> [${label}] command: ${command}\n`);
      writeLog(`==> [${label}] started: ${utcStamp()}\n`);
    }
    if (pipeOutput && child.stdout && child.stderr) {
      const writeOutput = (target: NodeJS.WriteStream, chunk: Uint8Array) => {
        resetNoOutputTimer();
        if (stream) {
          writeLog(chunk);
        } else {
          target.write(chunk);
        }
      };
      child.stdout.on("data", (chunk: Uint8Array) => writeOutput(process.stdout, chunk));
      child.stderr.on("data", (chunk: Uint8Array) => writeOutput(process.stderr, chunk));
      resetNoOutputTimer();
    }

    child.on("close", (status, signal) => {
      cancelled ??= Boolean(activeChildrenShutdownPromise);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      const finish = async (error?: unknown) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        killAt = undefined;
        // Process custody ends at the group join, independently of pending log I/O.
        if (error === undefined) {
          activeChildren.delete(child);
        }
        const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
        if (stream) {
          writeLog(
            `\n==> [${label}] finished: ${utcStamp()} status=${exitCode}${
              noOutputTimedOut ? " noOutputTimedOut=true" : ""
            }\n`,
          );
          if (!stream.destroyed) {
            stream.end();
          }
        }
        await logSettled;
        if (stream?.errored) {
          recordLogError(stream.errored);
        }
        stream?.removeListener("error", recordLogError);
        const errors = [...new Set([...(error === undefined ? [] : [error]), ...logErrors])];
        if (errors.length > 0) {
          throw errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Docker command cleanup and log publication failed", {
                cause: errors[0],
              });
        }
        resolve({
          signal,
          status: exitCode,
          timedOut,
          noOutputTimedOut,
          ...(cancelled ? { cancelled: true as const } : {}),
        });
      };
      void finishShellProcessTree(
        child,
        killAt,
        resolvedTimeoutKillGraceMs,
        timedOut ? undefined : "SIGTERM",
      )
        .then(() => finish(), finish)
        .catch(reject);
    });
  });
}

export function appendBoundedShellCapture(
  current: string,
  chunk: unknown,
  maxChars = SHELL_CAPTURE_MAX_CHARS,
) {
  const combined = `${current}${String(chunk)}`;
  if (combined.length <= maxChars) {
    return { text: combined, truncated: false };
  }
  return { text: combined.slice(-maxChars), truncated: true };
}

export function runShellCaptureCommand({
  command,
  env,
  label,
  timeoutMs,
  timeoutKillGraceMs = SHELL_TIMEOUT_KILL_GRACE_MS,
}: ShellCaptureOptions) {
  if (activeChildrenShutdownPromise) {
    return activeChildrenShutdownPromise.then(() => shellCaptureSkippedForShutdown(label));
  }
  return new Promise<ShellCaptureResult>((resolve, reject) => {
    const resolvedTimeoutMs = resolveOptionalTimerTimeoutMs(timeoutMs);
    const resolvedTimeoutKillGraceMs = resolveDockerSchedulerTimeoutMs(
      timeoutKillGraceMs,
      SHELL_TIMEOUT_KILL_GRACE_MS,
    );
    const child = spawn("bash", ["-c", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.set(child, resolvedTimeoutKillGraceMs);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled: boolean | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killAt: number | undefined;
    // Preserve terminal order even while a descendant still holds captured stdio.
    child.once("exit", () => {
      cancelled ??= Boolean(activeChildrenShutdownPromise);
    });
    const timeoutTimer =
      resolvedTimeoutMs !== undefined
        ? setTimeout(() => {
            cancelled ??= Boolean(activeChildrenShutdownPromise);
            timedOut = true;
            terminateChild(child, "SIGTERM");
            killAt = Date.now() + resolvedTimeoutKillGraceMs;
            killTimer = setTimeout(
              () => terminateChild(child, "SIGKILL"),
              resolvedTimeoutKillGraceMs,
            );
            killTimer.unref?.();
          }, resolvedTimeoutMs)
        : undefined;
    timeoutTimer?.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBoundedShellCapture(stdout, chunk);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBoundedShellCapture(stderr, chunk);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.on("close", (status, signal) => {
      cancelled ??= Boolean(activeChildrenShutdownPromise);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      const finish = (error?: unknown) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        killAt = undefined;
        if (error !== undefined) {
          reject(
            error instanceof Error
              ? error
              : new Error("Docker lane cleanup failed", { cause: error }),
          );
          return;
        }
        activeChildren.delete(child);
        const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
        resolve({
          label,
          signal,
          status: exitCode,
          stderr,
          stderrTruncated,
          stdout,
          stdoutTruncated,
          timedOut,
          ...(cancelled ? { cancelled: true as const } : {}),
        });
      };
      void finishShellProcessTree(
        child,
        killAt,
        resolvedTimeoutKillGraceMs,
        timedOut ? undefined : "SIGTERM",
      ).then(() => finish(), finish);
    });
  });
}

async function runForeground(label: string, command: string, env: NodeJS.ProcessEnv) {
  console.log(`==> ${label}`);
  const result = await runShellCommand({ command, env, label });
  throwIfSchedulerStopping(result);
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
}

export async function runCleanupSmokePhase(
  baseEnv: NodeJS.ProcessEnv,
  logDir: string,
  phases: Array<Record<string, unknown>>,
) {
  const command = prepareHarnessCommand("pnpm test:docker:cleanup", baseEnv);
  const logFile = path.join(logDir, `${CLEANUP_SMOKE_NAME}.log`);
  const startedAtMs = Date.now();
  let failure: LaneResult | undefined;
  try {
    await runPhase(phases, CLEANUP_SMOKE_NAME, {}, async () => {
      const result = await runShellCommand({
        command,
        env: baseEnv,
        label: CLEANUP_SMOKE_NAME,
        logFile,
      });
      if (result.status !== 0) {
        failure = cleanupSmokeResult(baseEnv, logFile, command, startedAtMs, result);
      }
      if (failure) {
        throw new Error(
          `Run cleanup smoke after parallel lanes failed with status ${failure.status}`,
        );
      }
    });
  } catch (error) {
    if (!failure) {
      throw error;
    }
  }
  return failure;
}

async function runForegroundGroup(entries: ForegroundEntry[], env: NodeJS.ProcessEnv) {
  const failures: Array<{ entry: ForegroundEntry; error: unknown }> = [];
  for (const entry of entries) {
    try {
      const { command, label, phaseDetails = {}, phases } = entry;
      const entryEnv = { ...env, ...entry.env };
      if (phases) {
        await runPhase(phases, `build:${label}`, phaseDetails, async () => {
          await runForeground(label, command, entryEnv);
        });
      } else {
        await runForeground(label, command, entryEnv);
      }
    } catch (error) {
      if (hasUnjoinedWork(error) && failures.length === 0) {
        throw error;
      }
      if (error === schedulerShutdownError && failures.length === 0) {
        throw error;
      }
      failures.push({ entry, error });
      if (hasUnjoinedWork(error) || activeChildrenShutdownPromise) {
        break;
      }
    }
  }
  if (failures.length > 0) {
    const primary = failures.find(({ error }) => hasUnjoinedWork(error)) ?? failures[0]!;
    throw new AggregateError(
      failures.map(({ error }) => error),
      failures
        .map(
          ({ entry, error }) =>
            `${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("\n"),
      { cause: primary.error },
    );
  }
}

async function runDockerPreflight(
  baseEnv: NodeJS.ProcessEnv,
  options: { cleanup: boolean; enabled: boolean; runTimeoutMs: number },
) {
  if (!options.enabled) {
    console.log("==> Docker preflight: skipped");
    return;
  }
  console.log("==> Docker preflight");
  const version = await runShellCaptureCommand({
    command: "docker version --format '{{.Server.Version}}'",
    env: baseEnv,
    label: "docker-version",
    timeoutMs: 20_000,
  });
  throwIfSchedulerStopping(version);
  if (version.status !== 0) {
    throw new Error(
      `Docker preflight failed: docker version status=${version.status}\n${version.stderr}${version.stdout}`,
    );
  }
  console.log(`==> Docker server: ${version.stdout.trim()}`);

  if (options.cleanup) {
    const stale = await runShellCaptureCommand({
      command:
        "docker ps -a --filter status=created --filter status=exited --filter status=dead --format '{{.Names}} {{.Status}}'",
      env: baseEnv,
      label: "docker-stale-list",
      timeoutMs: 20_000,
    });
    throwIfSchedulerStopping();
    if (stale.status === 0) {
      const names = dockerPreflightContainerNames(stale.stdout);
      if (names.length > 0) {
        console.log(`==> Docker preflight cleanup: ${names.join(", ")}`);
        const cleanup = await runShellCommand({
          command: `docker rm -f ${names.map(shellQuote).join(" ")}`,
          env: baseEnv,
          label: "docker-stale-cleanup",
          timeoutMs: 90_000,
        });
        throwIfSchedulerStopping(cleanup);
        if (cleanup.status !== 0) {
          throw new Error(`Docker preflight cleanup failed with status ${cleanup.status}`);
        }
      }
    }
  }

  const startedAt = Date.now();
  const run = await runShellCommand({
    command: dockerPreflightSmokeCommand(),
    env: baseEnv,
    label: "docker-run-smoke",
    timeoutMs: options.runTimeoutMs,
  });
  throwIfSchedulerStopping(run);
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (run.status !== 0) {
    throw new Error(
      `Docker preflight failed: ${dockerPreflightSmokeCommand()} status=${run.status} elapsed=${elapsedSeconds}s`,
    );
  }
  console.log(`==> Docker preflight run: ${elapsedSeconds}s`);
}

async function prepareOpenClawPackage(baseEnv: NodeJS.ProcessEnv, logDir: string) {
  const existing = baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ;
  if (existing) {
    const packageTgz = path.resolve(existing);
    baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ = packageTgz;
    baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
    baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
    console.log(`==> OpenClaw package: ${packageTgz}`);
    return;
  }

  const packDir = path.join(logDir, "openclaw-package");
  await mkdir(packDir, { recursive: true });
  const packageTgz = path.join(packDir, "openclaw-current.tgz");
  await runForeground(
    "Prepare OpenClaw package once",
    `node ${shellQuote(path.join(HARNESS_ROOT_DIR, "scripts/package-openclaw-for-docker.mjs"))} --source-dir ${shellQuote(ROOT_DIR)} --allow-unreleased-changelog --output-dir ${shellQuote(packDir)} --output-name openclaw-current.tgz`,
    baseEnv,
  );
  await fs.promises.access(packageTgz);
  // Preserve current-tree package intent in generated GitHub reruns; otherwise a local QA
  // failure would retry through the strict release path and fail before reaching its lane.
  baseEnv.OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG = "true";
  baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ = packageTgz;
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
  baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
  console.log(`==> OpenClaw package: ${baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ}`);
}

export function preparePrepublishPluginRegistry(
  plan: DockerCandidatePlan,
  logDir: string,
  sourceSha: string,
  candidateVersion: string,
) {
  const registryDir = path.join(logDir, "prepublish-plugin-registry");
  fs.rmSync(registryDir, { force: true, recursive: true });
  const artifact = createPrepublishPluginRegistryArtifact({
    repoRoot: ROOT_DIR,
    outputDir: registryDir,
    sourceSha,
    candidateVersion,
    requiredPackages: plan.requiredPrepublishPluginPackages,
  });
  return { dir: registryDir, candidateVersion, manifestSha256: artifact.manifestSha256 };
}

async function prepareDockerCandidate(
  plan: DockerCandidatePlan,
  logDir: string,
  manifestPath: string,
) {
  const sourceSha = gitOutput(ROOT_DIR, ["rev-parse", "HEAD"]);
  let candidate = null;
  if (plan.needs.package) {
    if (gitOutput(ROOT_DIR, ["status", "--porcelain=v1"])) {
      throw new Error("repository has working-tree changes; refusing to prepare Docker candidate");
    }
    const candidateEnv = commandEnv();
    for (const key of [...CANDIDATE_ENV_KEYS, ...REGISTRY_ENV_KEYS]) {
      delete candidateEnv[key];
    }
    await prepareOpenClawPackage(candidateEnv, logDir);
    const packagePath = candidateEnv.OPENCLAW_CURRENT_PACKAGE_TGZ!;
    const packed = inspectNpmPackageTarball(packagePath);
    const version = rootPackageVersion(ROOT_DIR);
    if (packed.packageJson.name !== "openclaw" || packed.packageJson.version !== version) {
      throw new Error("packed Docker candidate name or version differs from the root package");
    }
    let registry = null;
    if (plan.needs.prepublishPluginRegistry) {
      registry = preparePrepublishPluginRegistry(plan, logDir, sourceSha, version);
    }
    candidate = {
      package: { path: packagePath, name: packed.packageJson.name, version, sha256: packed.sha256 },
      registry,
    };
  }
  await mkdir(path.dirname(manifestPath), { recursive: true }).catch(recordPublicationFailure);
  try {
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ schema: "openclaw.qa-docker-candidate/v1", schemaVersion: 1, sourceSha, candidate }, null, 2)}\n`,
    );
  } catch (error) {
    recordPublicationFailure(error);
  }
}

function e2eImageForLane(poolLane: DockerE2eLane, baseEnv: NodeJS.ProcessEnv) {
  if (poolLane.e2eImageKind === "bare") {
    return baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE;
  }
  if (poolLane.e2eImageKind === "functional") {
    return baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE;
  }
  return undefined;
}

type DockerLaneEnv = {
  [key: string]: string | undefined;
  OPENCLAW_DOCKER_CACHE_HOME_DIR: string;
  OPENCLAW_DOCKER_CLI_TOOLS_DIR: string;
};

async function prepareBundledPluginSweepInventory(
  lanes: PreparedDockerLane[],
  baseEnv: NodeJS.ProcessEnv,
) {
  const configured = baseEnv.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS?.trim();
  delete baseEnv.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS;
  const sweepLanes = lanes.filter(({ name }) =>
    name.startsWith("bundled-plugin-install-uninstall-"),
  );
  if (sweepLanes.length === 0) {
    return;
  }
  let sweepIds =
    configured &&
    !["undefined", "null"].includes(configured) &&
    configured.split(/[,\s]+/u).some(Boolean)
      ? configured
      : undefined;
  if (sweepIds === undefined) {
    // Use the trusted inventory owner with frozen-target data, not target code or
    // the installed package: missing packaged plugins must remain observable.
    const { listBundledPluginPackArtifacts } =
      await import("./lib/bundled-plugin-build-entries.mjs");
    const artifacts = listBundledPluginPackArtifacts({
      cwd: ROOT_DIR,
      env: {
        ...baseEnv,
        OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
        OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: undefined,
      },
    });
    const expectedIds = artifacts.flatMap((artifact) => {
      const match = /^dist\/extensions\/([^/]+)\/openclaw\.plugin\.json$/u.exec(artifact);
      return match?.[1] ? [match[1]] : [];
    });
    if (expectedIds.length === 0) {
      throw new Error("frozen target has no packaged bundled plugin manifests to verify");
    }
    sweepIds = expectedIds.join(",");
  }
  // Every shard receives the same ordered inventory; the probe owns partitioning.
  for (const lane of sweepLanes) {
    lane.bundledPluginSweepIds = sweepIds;
  }
}

function laneEnv(
  poolLane: PreparedDockerLane,
  baseEnv: NodeJS.ProcessEnv,
  logDir: string,
  cacheKey: string | undefined,
): DockerLaneEnv {
  const name = poolLane.name;
  const cacheName = cacheKey || name;
  const env: DockerLaneEnv = {
    ...baseEnv,
    OPENCLAW_DOCKER_CACHE_HOME_DIR: path.resolve(
      process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR ?? path.join(logDir, `${cacheName}-cache`),
    ),
    OPENCLAW_DOCKER_CLI_TOOLS_DIR: path.resolve(
      process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR ?? path.join(logDir, `${cacheName}-cli-tools`),
    ),
  };
  env.OPENCLAW_DOCKER_ALL_LANE_NAME = name;
  if (poolLane.bundledPluginSweepIds !== undefined) {
    env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS = poolLane.bundledPluginSweepIds;
  }
  const image = e2eImageForLane(poolLane, baseEnv);
  if (image) {
    env.OPENCLAW_DOCKER_E2E_IMAGE = image;
  }
  if (poolLane.e2eImageKind) {
    env.OPENCLAW_DOCKER_E2E_IMAGE_KIND = poolLane.e2eImageKind;
  }
  return env;
}

async function runLane(
  lane: DockerE2eLane,
  baseEnv: NodeJS.ProcessEnv,
  logDir: string,
  fallbackTimeoutMs: number,
) {
  const { name } = lane;
  const timeoutMs = lane.timeoutMs ?? fallbackTimeoutMs;
  const noOutputTimeoutMs = lane.noOutputTimeoutMs;
  const logFile = path.join(logDir, `${name}.log`);
  const env = laneEnv(lane, baseEnv, logDir, lane.cacheKey);
  const command = prepareHarnessCommand(lane.command, env);
  await mkdir(env.OPENCLAW_DOCKER_CLI_TOOLS_DIR, { recursive: true });
  await mkdir(env.OPENCLAW_DOCKER_CACHE_HOME_DIR, { recursive: true });
  await fs.promises
    .writeFile(
      logFile,
      [
        `==> [${name}] cli tools dir: ${env.OPENCLAW_DOCKER_CLI_TOOLS_DIR}`,
        `==> [${name}] cache dir: ${env.OPENCLAW_DOCKER_CACHE_HOME_DIR}`,
        `==> [${name}] timeout: ${timeoutMs}ms`,
        `==> [${name}] no output timeout: ${noOutputTimeoutMs ?? 0}ms`,
        `==> [${name}] e2e image kind: ${lane.e2eImageKind ?? "none"}`,
        `==> [${name}] e2e image: ${env.OPENCLAW_DOCKER_E2E_IMAGE ?? ""}`,
        `==> [${name}] trusted harness: ${HARNESS_ROOT_DIR}`,
        `==> [${name}] candidate source: ${ROOT_DIR}`,
        "",
      ].join("\n"),
    )
    .catch(recordPublicationFailure);
  console.log(`==> [${name}] start`);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const result = await runShellCommand({
    command,
    env,
    label: name,
    logFile,
    timeoutMs,
    noOutputTimeoutMs,
  });
  const attempts = [laneAttempt(1, startedAt, result)];
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.status === 0) {
    console.log(`==> [${name}] pass ${elapsedSeconds}s`);
  } else {
    const timeoutLabel = result.timedOut ? " timeout" : "";
    console.error(
      `==> [${name}] fail${timeoutLabel} status=${result.status} ${elapsedSeconds}s log=${logFile}`,
    );
  }
  return {
    command,
    attempts,
    ...(result.cancelled ? { cancelled: true as const } : {}),
    finishedAt: new Date().toISOString(),
    image: env.OPENCLAW_DOCKER_E2E_IMAGE,
    imageKind: lane.e2eImageKind,
    logFile,
    name,
    elapsedSeconds,
    rerunCommand: buildLaneRerunCommand(name, baseEnv),
    startedAt: startedAtIso,
    status: result.status,
    noOutputTimedOut: result.noOutputTimedOut,
    timedOut: result.timedOut,
  };
}

async function runLanePool(
  poolLanes: DockerE2eLane[],
  baseEnv: NodeJS.ProcessEnv,
  logDir: string,
  parallelism: number,
  options: LanePoolOptions,
  { failures, results }: { failures: LaneResult[]; results: LaneResult[] },
) {
  const pending = [...poolLanes];
  const running = new Map<symbol, Promise<symbol>>();
  let firstError: { error: unknown } | undefined;
  const active = {
    count: 0,
    resources: new Map<string, number>(),
    weight: 0,
  } satisfies SchedulerActiveState;
  const activeLanes = new Map<string, number>();
  let lastLaneStartAt = 0;
  const statusTimer =
    options.statusIntervalMs > 0
      ? setInterval(() => {
          const runningSummary = [...activeLanes]
            .map(([name, startedAt]) => `${name}:${Math.round((Date.now() - startedAt) / 1000)}s`)
            .join(", ");
          const resources = [...active.resources.entries()]
            .map(([resource, value]) => `${resource}=${value}`)
            .join(" ");
          console.log(
            `==> [${options.poolLabel}] active=${active.count} pending=${pending.length} ${resources}${
              runningSummary ? ` lanes=${runningSummary}` : ""
            }`,
          );
        }, options.statusIntervalMs)
      : undefined;
  statusTimer?.unref?.();

  async function waitForLaneStartSlot() {
    if (options.startStaggerMs <= 0) {
      return;
    }
    const waitMs = Math.max(0, lastLaneStartAt + options.startStaggerMs - Date.now());
    if (waitMs > 0) {
      // Admission is serial. Its sole timer must not outlive a stopped pool.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          cancelLaneStartWait = undefined;
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        cancelLaneStartWait = finish;
      });
    }
    lastLaneStartAt = Date.now();
  }

  function canStartLane(candidate: DockerE2eLane) {
    return canStartSchedulerLane(candidate, active, parallelism, options);
  }

  function reserve(candidate: DockerE2eLane) {
    const weight = laneWeight(candidate);
    active.count += 1;
    active.weight += weight;
    for (const resource of laneResources(candidate)) {
      active.resources.set(resource, (active.resources.get(resource) ?? 0) + weight);
    }
  }

  function release(candidate: DockerE2eLane) {
    const weight = laneWeight(candidate);
    active.count -= 1;
    active.weight -= weight;
    for (const resource of laneResources(candidate)) {
      const next = (active.resources.get(resource) ?? 0) - weight;
      if (next > 0) {
        active.resources.set(resource, next);
      } else {
        active.resources.delete(resource);
      }
    }
  }

  async function startLane(poolLane: DockerE2eLane) {
    await waitForLaneStartSlot();
    if (firstError) {
      throw firstError.error;
    }
    if (activeChildrenShutdownPromise || (options.failFast && failures.length > 0)) {
      return;
    }
    reserve(poolLane);
    activeLanes.set(poolLane.name, Date.now());
    const id = Symbol(poolLane.name);
    const promise = runLane(poolLane, baseEnv, logDir, options.timeoutMs)
      .then((result) => {
        // Main retains every completed row, even when a sibling rejects before
        // Promise.race consumes it or the pool is draining after that rejection.
        results.push(result);
        if (result.status !== 0) {
          failures.push(result);
          schedulerFailed ||= !result.cancelled;
          if (options.failFast) {
            cancelLaneStartWait?.();
          }
        }
        return id;
      })
      .finally(() => {
        activeLanes.delete(poolLane.name);
        release(poolLane);
      });
    // A rejection can arrive while another lane is still waiting in the stagger.
    // Close admission immediately, but keep the rejected task in the join set.
    void promise.catch((error: unknown) => {
      firstError ??= { error };
      void (activeChildrenShutdownPromise ?? shutdownActiveChildren("SIGTERM", 1)).catch(
        () => undefined,
      );
    });
    running.set(id, promise);
  }

  try {
    while (pending.length > 0 || running.size > 0) {
      let started = false;
      if (!activeChildrenShutdownPromise && (!options.failFast || failures.length === 0)) {
        for (let index = 0; index < pending.length;) {
          if (activeChildrenShutdownPromise || (options.failFast && failures.length > 0)) {
            break;
          }
          const candidate = pending[index];
          if (!candidate) {
            break;
          }
          if (!canStartLane(candidate)) {
            index += 1;
            continue;
          }
          pending.splice(index, 1);
          await startLane(candidate);
          started = true;
        }
      }

      if (started) {
        continue;
      }
      if (running.size === 0) {
        if (activeChildrenShutdownPromise) {
          break;
        }
        const blocked = pending.map(laneSummary).join(", ");
        throw new Error(
          `No Docker lanes fit scheduler limits (${describeDockerSchedulerLimits(
            parallelism,
            options,
          )}): ${blocked}. Tune OPENCLAW_DOCKER_ALL_PARALLELISM, OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT, or OPENCLAW_DOCKER_ALL_<RESOURCE>_LIMIT.`,
        );
      }

      const id = await Promise.race(running.values());
      running.delete(id);
      if (options.failFast && failures.length > 0) {
        await Promise.all(running.values());
        running.clear();
        break;
      }
    }
  } catch (error) {
    const primaryError = firstError ? firstError.error : error;
    await (activeChildrenShutdownPromise ?? shutdownActiveChildren("SIGTERM", 1)).catch(
      () => undefined,
    );
    // Keep the first observed failure first without dropping independent drain failures.
    const errors = [primaryError];
    for (const result of await Promise.allSettled(running.values())) {
      if (result.status === "rejected" && !errors.includes(result.reason)) {
        errors.push(result.reason);
      }
    }
    throw errors.length === 1
      ? primaryError
      : new AggregateError(errors, "Docker lane pool failed", { cause: primaryError });
  } finally {
    cancelLaneStartWait?.();
    if (statusTimer) {
      clearInterval(statusTimer);
    }
  }
}

export async function tailFile(file: string, lines: number, maxBytes = LOG_TAIL_MAX_BYTES) {
  let content: string;
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(Math.max(1, maxBytes), stat.size);
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      content = buffer.toString("utf8");
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    content = "";
  }
  const tail = content.split(/\r?\n/).slice(-lines).join("\n");
  return tail.trimEnd();
}

async function printFailureSummary(failures: LaneResult[], tailLines: number) {
  console.error(`ERROR: ${failures.length} Docker lane(s) failed.`);
  for (const failure of failures) {
    console.error(`---- ${failure.name} failed (status=${failure.status}): ${failure.logFile}`);
    const tail = await tailFile(failure.logFile, tailLines);
    if (tail) {
      console.error(tail);
    }
  }
}

const activeChildren = new Map<ChildProcess, number>();
const childCleanups = new WeakMap<ChildProcess, Promise<void>>();
const cleanupFailures: unknown[] = [];
let activeChildrenShutdownPromise: Promise<number> | undefined;
let shutdownChildren: ChildProcess[] = [];
let cancelLaneStartWait: (() => void) | undefined;
// A later signal may join cleanup, but cannot replace an observed ordinary failure.
let schedulerFailed = false;
let requiredPublicationFailed = false;
let finalizeRunSummary: (() => Promise<void>) | undefined;
const schedulerShutdownError = new Error("Docker scheduler interrupted");

function recordPublicationFailure(error: unknown): never {
  requiredPublicationFailed = true;
  throw error;
}

function throwIfSchedulerStopping(result?: Pick<ShellCommandResult, "status" | "cancelled">) {
  if (activeChildrenShutdownPromise && (!result || result.cancelled || result.status === 0)) {
    throw schedulerShutdownError;
  }
}

function shellCommandSkippedForShutdown(signal: ShutdownSignal | null = null) {
  return {
    cancelled: true as const,
    noOutputTimedOut: false,
    signal,
    status: 143,
    timedOut: false,
  };
}

function shellCaptureSkippedForShutdown(label: string, signal: ShutdownSignal | null = null) {
  return {
    cancelled: true as const,
    label,
    signal,
    status: 143,
    stderr: "",
    stderrTruncated: false,
    stdout: "",
    stdoutTruncated: false,
    timedOut: false,
  };
}

const shellProcessGroupOptions = {
  errorPolicy: "alive-on-eperm",
  // Windows has no POSIX group probe; still require the owned leader to exit.
  inspectLeaderWhenNoGroup: true,
} as const;

function shellProcessGroupAlive(child: ChildProcess) {
  return inspectManagedProcessGroup(child, shellProcessGroupOptions) !== "dead";
}

function waitForShellProcessGroupExit(child: ChildProcess, timeoutMs: number) {
  return waitForManagedProcessGroupExit(child, timeoutMs, shellProcessGroupOptions);
}

function finishShellProcessTree(
  child: ChildProcess,
  killAt: number | undefined,
  timeoutKillGraceMs: number,
  initialSignal?: ShutdownSignal,
) {
  const existing = childCleanups.get(child);
  if (existing) {
    return existing;
  }
  // Leader close is not group completion. Command return and scheduler signals
  // join the same retained cleanup, including descendants that ignore stdio.
  const cleanup = (async () => {
    if (!shellProcessGroupAlive(child)) {
      return;
    }
    if (initialSignal) {
      terminateChild(child, initialSignal);
    }
    const graceRemainingMs =
      killAt === undefined ? timeoutKillGraceMs : Math.max(0, killAt - Date.now());
    if (graceRemainingMs > 0) {
      await waitForShellProcessGroupExit(child, graceRemainingMs);
    }
    if (shellProcessGroupAlive(child)) {
      terminateChild(child, "SIGKILL");
    }
    await waitForShellProcessGroupExit(child, SHELL_POST_FORCE_KILL_WAIT_MS);
    const state = inspectManagedProcessGroup(child, shellProcessGroupOptions);
    if (state !== "dead") {
      throw Object.assign(new Error(`Docker lane process group did not stop: ${child.pid}`), {
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processGroupId: child.pid,
        processTreeState: state,
      });
    }
  })().catch((error: unknown) => {
    throw recordShellCleanupFailure(error, child);
  });
  childCleanups.set(child, cleanup);
  return cleanup;
}

function recordShellCleanupFailure(error: unknown, child: ChildProcess) {
  const failure = hasUnjoinedWork(error)
    ? error
    : Object.assign(new Error("Docker lane cleanup could not be verified", { cause: error }), {
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processGroupId: child.pid,
        processTreeState: "indeterminate",
      });
  cleanupFailures.push(failure);
  // Fatal cleanup cannot leave admission open while the command joins pending log I/O.
  void (activeChildrenShutdownPromise ?? shutdownActiveChildren("SIGTERM", 1)).catch(
    () => undefined,
  );
  return failure;
}

function terminateChild(child: ChildProcess, signal: ShutdownSignal) {
  terminateManagedChild(child, signal, {
    onChildSignalError(error) {
      throw error;
    },
    useWindowsTaskkill: false,
  });
}

function shutdownActiveChildren(signal: ShutdownSignal, exitCode: number) {
  cancelLaneStartWait?.();
  if (activeChildrenShutdownPromise) {
    // Standalone second-signal escalation targets captured, still-owned groups.
    // Only positively joined commands have been released from activeChildren.
    for (const child of shutdownChildren) {
      if (!activeChildren.has(child)) {
        continue;
      }
      try {
        terminateChild(child, "SIGKILL");
      } catch (error) {
        recordShellCleanupFailure(error, child);
      }
    }
    return activeChildrenShutdownPromise;
  }
  const children = [...activeChildren.entries()];
  shutdownChildren = children.map(([child]) => child);
  activeChildrenShutdownPromise = Promise.allSettled(
    children.map(([child, grace]) =>
      finishShellProcessTree(child, Date.now() + grace, grace, signal),
    ),
  ).then(() => {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Docker process cleanup failed");
    }
    // 130/143 acknowledge joined signal cleanup, never merely receipt of a signal.
    return schedulerFailed ? 1 : exitCode;
  });
  return activeChildrenShutdownPromise;
}

function setSchedulerExitCode(exitCode?: number) {
  process.exitCode =
    cleanupFailures.length > 0
      ? CLEANUP_FAILURE_EXIT_CODE
      : schedulerFailed || requiredPublicationFailed
        ? 1
        : (exitCode ?? process.exitCode);
}

let signalDisposition: Promise<void> | undefined;
function handleShutdownSignal(signal: ShutdownSignal, exitCode: number) {
  const shutdown = shutdownActiveChildren(signal, exitCode);
  // Every signal may escalate cleanup, but only an actual signal owns process
  // disposition for imported helpers. Caught command failures belong to callers.
  signalDisposition ??= shutdown.then(
    (result) => {
      setSchedulerExitCode(result);
    },
    (error: unknown) => {
      if (!IS_MAIN) {
        console.error(error);
      }
      setSchedulerExitCode(CLEANUP_FAILURE_EXIT_CODE);
    },
  );
}

process.on("SIGINT", () => {
  handleShutdownSignal("SIGINT", 130);
});
process.on("SIGTERM", () => {
  handleShutdownSignal("SIGTERM", 143);
});

async function main() {
  const runStartedAt = new Date().toISOString();
  const phases: Array<Record<string, unknown>> = [];
  const parallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_PARALLELISM,
    DEFAULT_PARALLELISM,
    "OPENCLAW_DOCKER_ALL_PARALLELISM",
  );
  const tailParallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM,
    Math.min(parallelism, DEFAULT_TAIL_PARALLELISM),
    "OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM",
  );
  const tailLines = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES,
    DEFAULT_FAILURE_TAIL_LINES,
    "OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES",
  );
  const laneTimeoutMs = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS,
    DEFAULT_LANE_TIMEOUT_MS,
    "OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS",
  );
  const laneStartStaggerMs = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_START_STAGGER_MS,
    DEFAULT_LANE_START_STAGGER_MS,
    "OPENCLAW_DOCKER_ALL_START_STAGGER_MS",
  );
  const statusIntervalMs = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS,
    DEFAULT_STATUS_INTERVAL_MS,
    "OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS",
  );
  const preflightRunTimeoutMs = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT_RUN_TIMEOUT_MS,
    DEFAULT_PREFLIGHT_RUN_TIMEOUT_MS,
    "OPENCLAW_DOCKER_ALL_PREFLIGHT_RUN_TIMEOUT_MS",
  );
  const failFast = parseBool(process.env.OPENCLAW_DOCKER_ALL_FAIL_FAST, true);
  const dryRun = parseBool(process.env.OPENCLAW_DOCKER_ALL_DRY_RUN, false);
  const preflightEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT, true);
  const preflightCleanup = parseBool(process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT_CLEANUP, true);
  const timingsEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_TIMINGS, true);
  const buildEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_BUILD, true);
  const allowFrozenTargetScenarioOmissions = parseBool(
    process.env.OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS,
    false,
  );
  const planJson =
    cliOptions.planJson || parseBool(process.env.OPENCLAW_DOCKER_ALL_PLAN_JSON, false);
  const planReleaseAll = parseBool(process.env.OPENCLAW_DOCKER_ALL_PLAN_RELEASE_ALL, false);
  const profile = parseProfile(process.env.OPENCLAW_DOCKER_ALL_PROFILE);
  const releaseProfile = normalizeReleaseProfileEnv(
    process.env.OPENCLAW_DOCKER_ALL_RELEASE_PROFILE || process.env.OPENCLAW_RELEASE_PROFILE,
  );
  const releaseChunk = process.env.OPENCLAW_DOCKER_ALL_CHUNK || process.env.DOCKER_E2E_CHUNK || "";
  const includeOpenWebUI = parseBool(
    process.env.OPENCLAW_DOCKER_ALL_INCLUDE_OPENWEBUI ?? process.env.INCLUDE_OPENWEBUI,
    true,
  );
  const selectedLaneNamesRaw =
    process.env.OPENCLAW_DOCKER_ALL_LANES || process.env.DOCKER_E2E_LANES || "";
  const selectedLaneNames = parseLaneSelection(selectedLaneNamesRaw);
  if (selectedLaneNamesRaw && selectedLaneNames.length === 0) {
    throw new Error("OPENCLAW_DOCKER_ALL_LANES must include at least one lane name");
  }
  const liveMode = parseLiveMode(process.env.OPENCLAW_DOCKER_ALL_LIVE_MODE);
  const timingsFile = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_TIMINGS_FILE || DEFAULT_TIMINGS_FILE,
  );
  const runId = process.env.OPENCLAW_DOCKER_ALL_RUN_ID || utcStampForPath();
  const logDir = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_LOG_DIR ||
      path.join(ROOT_DIR, ".artifacts/docker-tests", runId),
  );

  const baseEnv = commandEnv({
    OPENCLAW_DOCKER_E2E_REPO_ROOT: ROOT_DIR,
    OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR: HARNESS_ROOT_DIR,
    OPENCLAW_LIVE_DOCKER_REPO_ROOT: ROOT_DIR,
    OPENCLAW_DOCKER_E2E_BARE_IMAGE:
      process.env.OPENCLAW_DOCKER_E2E_BARE_IMAGE ||
      process.env.OPENCLAW_DOCKER_E2E_IMAGE ||
      DEFAULT_E2E_BARE_IMAGE,
    OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE:
      process.env.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE ||
      process.env.OPENCLAW_DOCKER_E2E_IMAGE ||
      DEFAULT_E2E_FUNCTIONAL_IMAGE,
  });
  baseEnv.OPENCLAW_DOCKER_E2E_IMAGE =
    process.env.OPENCLAW_DOCKER_E2E_IMAGE || baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE;
  let summaryAttempted = false;
  const writeSummary = (summary: RunSummary) => {
    summaryAttempted = true;
    // Only final atomic promotion may publish a passing verdict.
    return writeRunSummary(logDir, { ...summary, status: "failed", runId }, baseEnv);
  };
  appendExtension(baseEnv, "matrix");
  appendExtension(baseEnv, "acpx");
  appendExtension(baseEnv, "codex");

  const timingStore = await loadTimingStore(timingsFile, timingsEnabled);
  const { omittedUnsupportedLaneNames, orderedLanes, orderedTailLanes, plan, scheduledLanes } =
    resolveDockerE2ePlan({
      includeOpenWebUI,
      liveMode,
      orderLanes,
      planReleaseAll: planJson && planReleaseAll,
      profile,
      releaseChunk,
      releaseProfile,
      selectedLaneNames,
      timingStore,
      upgradeSurvivorBaselines: process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS,
      upgradeSurvivorScenarios: process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
      upgradeSurvivorTargetRoot: process.env.OPENCLAW_UPGRADE_SURVIVOR_TARGET_ROOT,
      allowFrozenTargetScenarioOmissions,
    });
  if (omittedUnsupportedLaneNames.length > 0 && !allowFrozenTargetScenarioOmissions) {
    throw new Error(
      `frozen target scenario omissions require trusted workflow opt-in: ${omittedUnsupportedLaneNames.join(", ")}`,
    );
  }
  if (scheduledLanes.length === 0 && omittedUnsupportedLaneNames.length === 0) {
    throw new Error(
      [
        "resolved zero Docker lanes",
        `profile=${profile}`,
        `releaseChunk=${releaseChunk || "<none>"}`,
        `releaseProfile=${releaseProfile}`,
        `liveMode=${liveMode}`,
        `includeOpenWebUI=${includeOpenWebUI ? "1" : "0"}`,
        `selectedLanes=${selectedLaneNames.length > 0 ? selectedLaneNames.join(",") : "<none>"}`,
      ].join("; "),
    );
  }
  const omittedUnsupportedLanes =
    omittedUnsupportedLaneNames.length > 0 ? omittedUnsupportedLaneNames : undefined;

  if (cliOptions.preparePluginRegistry) {
    if (!plan.needs.prepublishPluginRegistry) {
      throw new Error("selected Docker lanes do not require a prepublish plugin registry");
    }
    const registry = preparePrepublishPluginRegistry(
      plan,
      logDir,
      gitOutput(ROOT_DIR, ["rev-parse", "HEAD"]),
      rootPackageVersion(ROOT_DIR),
    );
    process.stdout.write(`${JSON.stringify(registry)}\n`);
    return;
  }
  if (planJson) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const failures: LaneResult[] = [];
  const allResults: LaneResult[] = [];
  const summarySnapshot = (status: "failed" | "passed"): RunSummary => ({
    chunk: releaseChunk || undefined,
    failures,
    image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
    images: {
      bare: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
      functional: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
    },
    lanes: allResults,
    omittedUnsupportedLanes,
    phases,
    profile,
    runId,
    selectedLanes: selectedLaneNames.length > 0 ? selectedLaneNames : undefined,
    startedAt: runStartedAt,
    status,
  });
  if (!dryRun || cliOptions.prepareOnly) {
    finalizeRunSummary = async () => {
      const summary = () =>
        summarySnapshot(
          schedulerFailed || activeChildrenShutdownPromise || failures.length > 0
            ? "failed"
            : "passed",
        );
      if (!summaryAttempted) {
        await mkdir(logDir, { recursive: true }).catch(recordPublicationFailure);
        await writeSummary(summary());
      }
      if (!requiredPublicationFailed && cleanupFailures.length === 0 && activeChildren.size === 0) {
        await commitJoinedSummary(logDir, summary, baseEnv);
      }
    };
  }
  if (cliOptions.prepareOnly) {
    await prepareDockerCandidate(plan, logDir, path.resolve(cliOptions.prepareOnly));
    return;
  }

  await mkdir(logDir, { recursive: true }).catch(recordPublicationFailure);
  console.log(`==> Docker test logs: ${logDir}`);
  console.log(`==> Profile: ${profile}${releaseChunk ? ` chunk=${releaseChunk}` : ""}`);
  if (profile === RELEASE_PATH_PROFILE) {
    console.log(`==> Release profile: ${releaseProfile}`);
  }
  console.log(`==> Parallelism: ${parallelism}`);
  console.log(`==> Tail parallelism: ${tailParallelism}`);
  console.log(`==> Lane timeout: ${laneTimeoutMs}ms`);
  console.log(`==> Live mode: ${liveMode}`);
  console.log(`==> Lane start stagger: ${laneStartStaggerMs}ms`);
  console.log(`==> Status interval: ${statusIntervalMs}ms`);
  console.log(`==> Fail fast: ${failFast ? "yes" : "no"}`);
  console.log(`==> Dry run: ${dryRun ? "yes" : "no"}`);
  console.log(
    `==> Docker preflight: ${preflightEnabled ? "yes" : "no"}${
      preflightCleanup ? " cleanup=yes" : " cleanup=no"
    }`,
  );
  console.log(`==> Build shared Docker images: ${buildEnabled ? "yes" : "no"}`);
  console.log(`==> Docker E2E bare image: ${baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE}`);
  console.log(`==> Docker E2E functional image: ${baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE}`);
  if (profile === RELEASE_PATH_PROFILE) {
    console.log(`==> Include Open WebUI: ${includeOpenWebUI ? "yes" : "no"}`);
  }
  if (selectedLaneNames.length > 0) {
    console.log(`==> Selected lanes: ${selectedLaneNames.join(", ")}`);
  }
  console.log(`==> Docker lane timings: ${timingStore.enabled ? timingsFile : "disabled"}`);
  console.log(`==> Live-test bundled plugins: ${baseEnv.OPENCLAW_DOCKER_BUILD_EXTENSIONS}`);
  const schedulerOptions = parseSchedulerOptions(process.env, parallelism);
  const tailSchedulerOptions = parseSchedulerOptions(process.env, tailParallelism);
  console.log(
    `==> Scheduler: weight=${schedulerOptions.weightLimit} ${resourceLimitsSummary(schedulerOptions.resourceLimits)}`,
  );
  console.log(
    `==> Tail scheduler: weight=${tailSchedulerOptions.weightLimit} ${resourceLimitsSummary(tailSchedulerOptions.resourceLimits)}`,
  );
  printLaneManifest("Main", orderedLanes, timingStore);
  printLaneManifest("Tail", orderedTailLanes, timingStore);
  if (omittedUnsupportedLanes) {
    console.log(
      `==> Docker lanes omitted: target lacks ${omittedUnsupportedLanes.join(", ")} scenario support`,
    );
  }
  if (dryRun) {
    console.log("==> Dry run complete");
    return;
  }
  validateDockerCandidateEnvironment(baseEnv, plan);

  // An authorized frozen target can prove that a selected scenario did not exist yet.
  // Preserve that explicit non-outcome instead of fabricating a failed execution.
  if (scheduledLanes.length === 0) {
    await writeSummary({
      chunk: releaseChunk || undefined,
      failures: [],
      lanes: [],
      omittedUnsupportedLanes,
      phases,
      profile,
      selectedLanes: selectedLaneNames.length > 0 ? selectedLaneNames : undefined,
      startedAt: runStartedAt,
      status: "passed",
    });
    console.log(
      "==> No selected Docker lane is supported by the frozen target; finalizing run summary",
    );
    return;
  }

  await prepareBundledPluginSweepInventory(scheduledLanes, baseEnv);

  await runPhase(
    phases,
    "docker-preflight",
    { cleanup: preflightCleanup, enabled: preflightEnabled },
    async () => {
      await runDockerPreflight(baseEnv, {
        cleanup: preflightCleanup,
        enabled: preflightEnabled,
        runTimeoutMs: preflightRunTimeoutMs,
      });
    },
  );
  if (lanesNeedOpenClawPackage(scheduledLanes)) {
    await runPhase(phases, "prepare-openclaw-package", {}, async () => {
      await prepareOpenClawPackage(baseEnv, logDir);
    });
  } else {
    console.log("==> OpenClaw package: not needed for selected lanes");
  }
  if (plan.needs.prepublishPluginRegistry && !baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR) {
    await runPhase(phases, "prepare-prepublish-plugin-registry", {}, async () => {
      const registry = preparePrepublishPluginRegistry(
        plan,
        logDir,
        gitOutput(ROOT_DIR, ["rev-parse", "HEAD"]),
        rootPackageVersion(ROOT_DIR),
      );
      baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR = registry.dir;
      baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION = registry.candidateVersion;
      baseEnv.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256 = registry.manifestSha256;
    });
  }

  if (buildEnabled) {
    const buildEntries: ForegroundEntry[] = [];
    if (scheduledLanes.some((poolLane) => poolLane.needsLiveImage)) {
      buildEntries.push({
        command: liveDockerScriptCommand("test-live-build-docker.sh", "", { skipBuild: false }),
        label: "shared live-test image once",
        phaseDetails: { imageKind: "live" },
        phases,
      });
    }
    if (lanesNeedE2eImageKind(scheduledLanes, "bare")) {
      buildEntries.push({
        command: prepareHarnessCommand("pnpm test:docker:e2e-build", baseEnv),
        env: {
          OPENCLAW_DOCKER_E2E_IMAGE: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
          OPENCLAW_DOCKER_E2E_TARGET: "bare",
        },
        label: `shared bare Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE}`,
        phaseDetails: { image: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE, imageKind: "bare" },
        phases,
      });
    }
    if (lanesNeedE2eImageKind(scheduledLanes, "functional")) {
      buildEntries.push({
        command: prepareHarnessCommand("pnpm test:docker:e2e-build", baseEnv),
        env: {
          OPENCLAW_DOCKER_E2E_IMAGE: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
          OPENCLAW_DOCKER_E2E_TARGET: "functional",
        },
        label: `shared functional Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE}`,
        phaseDetails: {
          image: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
          imageKind: "functional",
        },
        phases,
      });
    }
    await runForegroundGroup(buildEntries, baseEnv);
  } else {
    console.log(`==> Shared Docker image builds: skipped`);
  }

  const options = {
    ...schedulerOptions,
    failFast,
    poolLabel: "main",
    startStaggerMs: laneStartStaggerMs,
    statusIntervalMs,
    timeoutMs: laneTimeoutMs,
  } satisfies LanePoolOptions;
  const writeLaneSummary = (status: "failed" | "passed") => writeSummary(summarySnapshot(status));
  async function runPool(
    poolLanes: DockerE2eLane[],
    poolParallelism: number,
    poolOptions: LanePoolOptions,
  ) {
    const firstResult = allResults.length;
    try {
      await runPhase(
        phases,
        `${poolOptions.poolLabel}-lane-pool`,
        { lanes: poolLanes.length },
        () =>
          runLanePool(poolLanes, baseEnv, logDir, poolParallelism, poolOptions, {
            failures,
            results: allResults,
          }),
      );
    } catch (error) {
      // A fatal lane has no result row. Preserve the completed prefix and drain
      // results as raw failed-run evidence without acknowledging successful cleanup.
      const errors = [error];
      try {
        await writeLaneSummary("failed");
      } catch (publicationError) {
        errors.push(publicationError);
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Docker lane pool failed and its partial summary could not be published",
          { cause: error },
        );
      }
      throw error;
    }
    await writeTimingStore(timingStore, allResults.slice(firstResult));
  }
  await runPool(orderedLanes, parallelism, options);
  if (activeChildrenShutdownPromise || (failFast && failures.length > 0)) {
    await writeLaneSummary("failed");
    await printFailureSummary(failures, tailLines);
    process.exitCode = 1;
    return;
  }

  if (orderedTailLanes.length > 0) {
    console.log("==> Running provider-sensitive Docker tail lanes");
    await runPool(orderedTailLanes, tailParallelism, {
      ...options,
      ...tailSchedulerOptions,
      poolLabel: "tail",
    });
  } else {
    console.log("==> Provider-sensitive Docker tail lanes: none");
  }
  if (activeChildrenShutdownPromise || failures.length > 0) {
    await writeLaneSummary("failed");
    await printFailureSummary(failures, tailLines);
    process.exitCode = 1;
    return;
  }

  if (profile === DEFAULT_PROFILE && selectedLaneNames.length === 0) {
    const cleanupFailure = await runCleanupSmokePhase(baseEnv, logDir, phases);
    if (cleanupFailure) {
      failures.push(cleanupFailure);
      schedulerFailed ||= !cleanupFailure.cancelled;
    }
  } else {
    console.log("==> Cleanup smoke after parallel lanes: skipped for selected/release lanes");
  }
  await writeTimingStore(timingStore, allResults);
  if (activeChildrenShutdownPromise || failures.length > 0) {
    await writeLaneSummary("failed");
    await printFailureSummary(failures, tailLines);
    process.exitCode = 1;
    return;
  }
  await writeLaneSummary("passed");
  console.log("==> Docker lane execution passed; finalizing run summary");
}

if (IS_MAIN) {
  const failures: unknown[] = [];
  const reported = new Set<object>();
  const reportFailure = (error: unknown) => {
    if (error && typeof error === "object") {
      if (reported.has(error)) {
        return;
      }
      reported.add(error);
    }
    console.error(coerceErrorMessage(error));
    // Aggregate members preserve command order; causes may point back into
    // that graph. Distinct errors with identical messages must remain visible.
    if (error instanceof AggregateError) {
      for (const member of error.errors) {
        reportFailure(member);
      }
    }
    if (error && typeof error === "object") {
      if ("cause" in error) {
        reportFailure(error.cause);
      }
      if ("error" in error) {
        reportFailure(error.error);
      }
    }
  };
  try {
    await main();
  } catch (error) {
    schedulerFailed ||= error !== schedulerShutdownError;
    if (hasUnjoinedWork(error) && !cleanupFailures.includes(error)) {
      cleanupFailures.push(error);
    }
    if (error !== schedulerShutdownError) {
      failures.push(error);
    }
  } finally {
    // Main may finish as soon as a lane leader exits. Retain the scheduler until
    // its separately detached lane groups have actually stopped.
    const shutdownExitCode = await activeChildrenShutdownPromise?.catch((error: unknown) => {
      failures.push(error);
      return 1;
    });
    // Diagnostic work precedes the summary's final affirmative publication.
    for (const error of failures) {
      reportFailure(error);
    }
    try {
      await finalizeRunSummary?.();
    } catch (error) {
      schedulerFailed = true;
      reportFailure(error);
    }
    // Successful cleanup cannot erase an unrelated publication/preparation failure.
    setSchedulerExitCode(shutdownExitCode);
  }
}
