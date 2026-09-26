// Tracks uploaded mobile store builds with non-tag Git refs.
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  androidStoreCutoverRef,
  androidStoreReleaseRef,
  type AndroidStorePlan,
  validateAndroidStorePlan,
} from "./lib/android-store-version.ts";

type MobileReleasePlatform = "ios" | "android";
type MobileReleaseCommand = "preflight" | "record" | "resolve" | "initialize-android";

type GitDeps = {
  execFileSync?: (
    command: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string;
};

type MobileReleaseOptions = {
  androidPlan?: AndroidStorePlan;
  build: string | null;
  command: MobileReleaseCommand;
  platform: MobileReleasePlatform;
  remote: string;
  rootDir: string;
  sha: string;
  version: string;
  versionCode: string | null;
};

type RemoteRefState = {
  ref: string;
  sha: string;
};

const REF_PREFIX = "refs/openclaw/mobile-releases";
const VERSION_RE = /^20\d{2}\.(?:[1-9]\d?)\.(?:[1-9]\d*)$/u;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/u;

function git(args: string[], rootDir: string, deps: GitDeps = {}): string {
  const exec = deps.execFileSync ?? execFileSync;
  return exec("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function errorOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value) ?? Object.prototype.toString.call(value);
}

function gitAllowFailure(
  args: string[],
  rootDir: string,
  deps: GitDeps = {},
): { ok: boolean; stdout: string; stderr: string } {
  try {
    return { ok: true, stdout: git(args, rootDir, deps), stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = errorOutput(e.stdout);
    const stderr = errorOutput(e.stderr);
    return { ok: false, stdout, stderr };
  }
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parsePlatform(raw: string | null): MobileReleasePlatform {
  if (raw === "ios" || raw === "android") {
    return raw;
  }
  throw new Error("Missing or invalid --platform. Expected ios or android.");
}

function parseCommand(raw: string | undefined): MobileReleaseCommand {
  if (raw === "-h" || raw === "--help") {
    throw new Error(usage());
  }
  if (
    raw === "preflight" ||
    raw === "record" ||
    raw === "resolve" ||
    raw === "initialize-android"
  ) {
    return raw;
  }
  throw new Error(
    `Unknown command '${raw ?? ""}'. Expected preflight, record, resolve, or initialize-android.`,
  );
}

export function parseArgs(argv: string[]): MobileReleaseOptions {
  const command = parseCommand(argv[0]);
  let build: string | null = null;
  let platform: string | null = null;
  let remote = "origin";
  let rootDir = path.resolve(".");
  let sha = "HEAD";
  let version = "";
  let versionCode: string | null = null;
  let planPath: string | null = null;
  let explicitSha = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--platform":
        platform = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--version":
        version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--build":
        build = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--version-code":
        versionCode = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--sha":
        sha = readOptionValue(argv, index, arg);
        explicitSha = true;
        index += 1;
        break;
      case "--plan":
        planPath = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--remote":
        remote = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--root":
        rootDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "-h":
      case "--help":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const androidPlan = planPath
    ? validateAndroidStorePlan(JSON.parse(readFileSync(planPath, "utf8")))
    : undefined;
  if (command === "initialize-android" && !androidPlan) {
    throw new Error("initialize-android requires --plan with a validated Android v2 store plan.");
  }
  if (androidPlan) {
    if (
      (platform !== null && platform !== "android") ||
      (version && version !== androidPlan.version) ||
      (versionCode !== null && versionCode !== String(androidPlan.versionCode)) ||
      (build !== null && build !== String(androidPlan.buildNumber)) ||
      (explicitSha && sha !== androidPlan.sourceSha)
    ) {
      throw new Error("Explicit release identity does not match the Android store plan.");
    }
    platform = "android";
    version = androidPlan.version;
    versionCode = String(androidPlan.versionCode);
    build = String(androidPlan.buildNumber);
    sha = androidPlan.sourceSha;
  }

  return {
    ...(androidPlan ? { androidPlan } : {}),
    build,
    command,
    platform: parsePlatform(platform),
    remote,
    rootDir,
    sha,
    version,
    versionCode,
  };
}

function validateVersion(version: string): string {
  const trimmed = version.trim();
  if (!VERSION_RE.test(trimmed)) {
    throw new Error(`Invalid mobile release version '${version}'. Expected YYYY.M.D.`);
  }
  return trimmed;
}

function validatePositiveInteger(label: string, value: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!POSITIVE_INTEGER_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} '${value ?? ""}'. Expected a positive integer.`);
  }
  return trimmed;
}

function androidVersionCodePrefix(version: string): string {
  const [year, rawMonth, rawPatch] = version.split(".");
  return `${year}${rawMonth?.padStart(2, "0")}${rawPatch?.padStart(2, "0")}`;
}

function validateAndroidVersionCode(version: string, versionCode: string | null): string {
  const code = validatePositiveInteger("Android versionCode", versionCode);
  const prefix = androidVersionCodePrefix(version);
  const suffix = Number.parseInt(code.slice(prefix.length), 10);
  if (
    !code.startsWith(prefix) ||
    code.length !== prefix.length + 2 ||
    !Number.isInteger(suffix) ||
    suffix < 1 ||
    suffix > 99
  ) {
    throw new Error(
      `Invalid Android versionCode '${code}'. Expected ${prefix}01 through ${prefix}99 for version ${version}.`,
    );
  }
  return code;
}

export function mobileReleaseRefFor(options: {
  androidPlan?: AndroidStorePlan;
  build?: string | null;
  platform: MobileReleasePlatform;
  version: string;
  versionCode?: string | null;
}): string {
  if (options.androidPlan) {
    const plan = validateAndroidStorePlan(options.androidPlan);
    if (
      options.platform !== "android" ||
      options.version !== plan.version ||
      (options.versionCode != null && options.versionCode !== String(plan.versionCode)) ||
      (options.build != null && options.build !== String(plan.buildNumber))
    ) {
      throw new Error("Release identity does not match the Android store plan.");
    }
    return androidStoreReleaseRef(plan);
  }
  const version = validateVersion(options.version);
  if (options.platform === "ios") {
    const build = validatePositiveInteger("iOS build", options.build ?? null);
    return `${REF_PREFIX}/ios/${version}-${build}`;
  }

  const versionCode = validateAndroidVersionCode(version, options.versionCode ?? null);
  return `${REF_PREFIX}/android/${version}-${versionCode}`;
}

function assertRootDir(rootDir: string): void {
  if (!existsSync(path.join(rootDir, ".git"))) {
    throw new Error(`Not a Git checkout root: ${rootDir}`);
  }
}

function resolveCommitSha(sha: string, rootDir: string, deps: GitDeps = {}): string {
  return git(["rev-parse", "--verify", `${sha}^{commit}`], rootDir, deps).trim();
}

function readRemoteRef(
  remote: string,
  ref: string,
  rootDir: string,
  deps: GitDeps = {},
): RemoteRefState | null {
  const refs = readRemoteRefs(remote, ref, rootDir, deps);
  if (refs.length === 0) {
    return null;
  }
  if (refs.length !== 1 || refs[0]?.ref !== ref) {
    throw new Error(`Unexpected remote ref lookup output for ${ref}.`);
  }
  return refs[0];
}

function readRemoteRefs(
  remote: string,
  pattern: string,
  rootDir: string,
  deps: GitDeps = {},
): RemoteRefState[] {
  const result = gitAllowFailure(["ls-remote", "--refs", remote, pattern], rootDir, deps);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Failed to inspect remote release ref ${pattern}: ${detail}`);
  }

  const output = result.stdout.trim();
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/u).map((line) => {
    const [sha, ref, extra] = line.split(/\s+/u);
    if (!sha || !/^[a-f0-9]{40}$/u.test(sha) || !ref?.startsWith("refs/") || extra) {
      throw new Error(`Unexpected remote ref lookup output for ${pattern}: ${line}`);
    }
    return { ref, sha };
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function recoveryCommand(options: { ref: string; remote: string; sha: string }): string {
  return `git push --force-with-lease=${options.ref}: ${options.remote} ${options.sha}:${options.ref}`;
}

function resolveReleaseSha(options: MobileReleaseOptions, deps: GitDeps): string {
  const sha = resolveCommitSha(options.sha, options.rootDir, deps);
  if (options.androidPlan && sha !== options.androidPlan.sourceSha) {
    throw new Error("Release source SHA does not match the Android store plan.");
  }
  return sha;
}

function createRemoteRef(
  options: {
    acceptExistingSha?: boolean;
    ref: string;
    remote: string;
    rootDir: string;
    sha: string;
  },
  deps: GitDeps,
): RemoteRefState & { status: "created" | "already-recorded" } {
  const result = gitAllowFailure(
    ["push", `--force-with-lease=${options.ref}:`, options.remote, `${options.sha}:${options.ref}`],
    options.rootDir,
    deps,
  );
  // A transport failure can follow an accepted push. Read back before offering recovery.
  const recorded = readRemoteRef(options.remote, options.ref, options.rootDir, deps);
  if (recorded && (recorded.sha === options.sha || options.acceptExistingSha)) {
    return { ...recorded, status: result.ok ? "created" : "already-recorded" };
  }
  if (recorded) {
    throw new Error(
      `Mobile release ref ${options.ref} already points at ${recorded.sha}; refusing to record ${options.sha}.`,
    );
  }
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(
    `Failed to create mobile release ref ${options.ref}. Recovery command:\n${recoveryCommand(options)}\n${detail}`,
  );
}

function readAndroidCutoverMarker(
  options: { ref: string; remote: string; rootDir: string },
  deps: GitDeps,
): RemoteRefState | null {
  const markers = readRemoteRefs(
    options.remote,
    `${REF_PREFIX}/android/cutover-v2/*`,
    options.rootDir,
    deps,
  );
  if (markers.length > 1) {
    throw new Error(
      "Multiple Android store version cutover markers exist; reconcile them before releasing.",
    );
  }
  const marker = markers[0];
  if (marker && marker.ref !== options.ref) {
    throw new Error(
      `Android store cutover marker ${marker.ref} does not match planned ${options.ref}; refusing to change the legacy maximum.`,
    );
  }
  return marker ?? null;
}

export function initializeAndroidStoreRelease(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): RemoteRefState & { status: "created" | "already-recorded" } {
  assertRootDir(options.rootDir);
  if (!options.androidPlan) {
    throw new Error("Android store initialization requires a validated Android v2 store plan.");
  }
  mobileReleaseRefFor(options);
  const sha = resolveReleaseSha(options, deps);
  const ref = androidStoreCutoverRef(options.androidPlan.legacyMaxVersionCode);
  const markerOptions = { ref, remote: options.remote, rootDir: options.rootDir };
  const existing = readAndroidCutoverMarker(markerOptions, deps);
  if (existing) {
    return { ...existing, status: "already-recorded" };
  }
  const result = createRemoteRef({ ...markerOptions, sha, acceptExistingSha: true }, deps);
  // The maximum is immutable across releases, including a concurrent initializer.
  readAndroidCutoverMarker(markerOptions, deps);
  return result;
}

export function preflightMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string; status: "available" | "already-recorded" } {
  assertRootDir(options.rootDir);
  const ref = mobileReleaseRefFor(options);
  const sha = resolveReleaseSha(options, deps);
  const existing = readRemoteRef(options.remote, ref, options.rootDir, deps);

  if (!existing) {
    return { ref, sha, status: "available" };
  }
  if (existing.sha === sha) {
    return { ref, sha, status: "already-recorded" };
  }

  throw new Error(
    `Mobile release ref ${ref} already points at ${existing.sha}; refusing to record ${sha}.`,
  );
}

export function recordMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string; status: "created" | "already-recorded" } {
  const preflight = preflightMobileReleaseRef(options, deps);
  if (preflight.status === "already-recorded") {
    return { ...preflight, status: "already-recorded" };
  }

  return createRemoteRef(
    { ref: preflight.ref, sha: preflight.sha, remote: options.remote, rootDir: options.rootDir },
    deps,
  );
}

export function resolveMobileReleaseRef(
  options: MobileReleaseOptions,
  deps: GitDeps = {},
): { ref: string; sha: string } {
  assertRootDir(options.rootDir);
  const ref = mobileReleaseRefFor(options);
  const existing = readRemoteRef(options.remote, ref, options.rootDir, deps);
  if (!existing) {
    throw new Error(`Mobile release ref ${ref} does not exist on ${options.remote}.`);
  }
  if (options.androidPlan && existing.sha !== options.androidPlan.sourceSha) {
    throw new Error(
      `Mobile release ref ${ref} does not record Android plan source ${options.androidPlan.sourceSha}.`,
    );
  }
  return { ref, sha: existing.sha };
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/mobile-release-ref.ts preflight --platform ios --version YYYY.M.D --build N [--sha HEAD] [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts record --platform android --version YYYY.M.D --version-code YYYYMMDDNN [--sha HEAD] [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts resolve --platform ios --version YYYY.M.D --build N [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts <preflight|record|resolve> --plan android-plan.json [--remote origin]",
    "  node --import tsx scripts/mobile-release-ref.ts initialize-android --plan android-plan.json [--remote origin]",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options.command === "initialize-android") {
      const result = initializeAndroidStoreRelease(options);
      const verb = result.status === "already-recorded" ? "already records" : "recorded";
      process.stdout.write(`Android store cutover ${result.ref} ${verb} ${result.sha}.\n`);
      return 0;
    }
    if (options.command === "preflight") {
      const result = preflightMobileReleaseRef(options);
      const suffix =
        result.status === "already-recorded"
          ? `already records ${shortSha(result.sha)}`
          : `available for ${shortSha(result.sha)}`;
      process.stdout.write(`Mobile release ref ${result.ref} is ${suffix}.\n`);
      return 0;
    }

    if (options.command === "record") {
      const result = recordMobileReleaseRef(options);
      const verb = result.status === "already-recorded" ? "already records" : "recorded";
      process.stdout.write(`Mobile release ref ${result.ref} ${verb} ${result.sha}.\n`);
      return 0;
    }

    const result = resolveMobileReleaseRef(options);
    process.stdout.write(`${result.sha}\t${result.ref}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
