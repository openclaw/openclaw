import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 as pathWin32 } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePackageSourceDir } from "../../package-source-preflight.mjs";
import type { CandidateBuild, LaneCommandParams, LaneState, PackageJson } from "./config.ts";
import {
  CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES,
  PUBLISHED_INSTALLER_BASE_URL,
  installTimeoutMs,
  resolvePackDestinationTarball,
} from "./config.ts";
import { readLogTextWindow } from "./logs.ts";
import { runCommand } from "./process.ts";
import { logPhase } from "./reporting.ts";
import { resolveCommandPath, shellEscapeForSh, sleep } from "./shared.ts";

export async function prepareCandidate(params: {
  outputDir: string;
  sourceDir: string;
  logsDir: string;
}): Promise<CandidateBuild> {
  logPhase("prepare", "resolve-source-sha");
  validatePackageSourceDir(params.sourceDir, { allowUnreleasedChangelog: true });
  const packageJson = readPackageJson(params.sourceDir);
  const hasUiBuildScript = packageJsonHasScript(packageJson, "ui:build");
  const sourceSha = (
    await runCommand(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: params.sourceDir,
      logPath: join(params.logsDir, "git-rev-parse.log"),
    })
  ).stdout.trim();

  const buildEnv = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=8192",
  };

  logPhase("prepare", "pnpm-install");
  await runCommand(pnpmCommand(), ["install", "--frozen-lockfile"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-install.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  logPhase("prepare", "pnpm-build");
  await runCommand(pnpmCommand(), ["build"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-build.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  if (hasUiBuildScript) {
    // pnpm build does not regenerate dist/control-ui, and checked-in bundles can
    // otherwise leak into npm pack when a ref changes UI assets.
    logPhase("prepare", "pnpm-ui-build");
    await runCommand(pnpmCommand(), ["ui:build"], {
      cwd: params.sourceDir,
      env: buildEnv,
      logPath: join(params.logsDir, "pnpm-ui-build.log"),
      timeoutMs: 30 * 60 * 1000,
    });
  }

  const packDir = join(params.outputDir, "package");
  mkdirSync(packDir, { recursive: true });
  const packJsonPath = join(packDir, "pack.json");
  // Supported source checkouts own inventory and bundled dependency preparation.
  logPhase("prepare", "package-candidate");
  const packResult = await runCommand(
    process.execPath,
    [
      join(params.sourceDir, "scripts", "package-openclaw-for-docker.mjs"),
      "--skip-build",
      "--output-dir",
      packDir,
    ],
    {
      cwd: params.sourceDir,
      logPath: join(params.logsDir, "package-candidate.log"),
      timeoutMs: 15 * 60 * 1000,
    },
  );
  const packedCandidate = resolvePackDestinationTarball(
    packResult.stdout.trim().split(/\r?\n/u).findLast(Boolean),
    packDir,
    "package-openclaw-for-docker",
  );
  writeFileSync(
    packJsonPath,
    `${JSON.stringify({ filename: packedCandidate.fileName, path: packedCandidate.path, version: packageJson.version }, null, 2)}\n`,
    "utf8",
  );

  return {
    sourceDir: params.sourceDir,
    sourceSha,
    candidateVersion: (packageJson.version ?? "").trim(),
    candidateTgz: packedCandidate.path,
    candidateFileName: packedCandidate.fileName,
  };
}

export function readProvidedCandidate(params: {
  candidateTgz: string;
  candidateVersion: string;
  sourceSha: string;
}): CandidateBuild {
  if (!params.candidateTgz) {
    throw new Error("Missing required --candidate-tgz argument when --source-dir is not provided.");
  }
  if (!existsSync(params.candidateTgz)) {
    throw new Error(`Candidate package not found: ${params.candidateTgz}`);
  }
  if (!params.candidateVersion) {
    throw new Error(
      "Missing required --candidate-version argument when --source-dir is not provided.",
    );
  }
  if (!params.sourceSha) {
    throw new Error("Missing required --source-sha argument when --source-dir is not provided.");
  }
  return {
    sourceDir: "",
    sourceSha: params.sourceSha,
    candidateVersion: params.candidateVersion,
    candidateTgz: params.candidateTgz,
    candidateFileName: params.candidateTgz.split(/[/\\]/u).at(-1) ?? "",
  };
}

function readPackageJson(packageRoot: string): PackageJson {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function packageJsonHasScript(packageJson: PackageJson, scriptName: string) {
  return typeof packageJson?.scripts?.[scriptName] === "string";
}

export function packageHasScript(packageRoot: string, scriptName: string) {
  try {
    return packageJsonHasScript(readPackageJson(packageRoot), scriptName);
  } catch {
    return false;
  }
}

export function normalizeWindowsInstalledCliPath(commandPath: string) {
  if (typeof commandPath !== "string") {
    return commandPath;
  }
  return commandPath.replace(/\.ps1$/iu, ".cmd");
}

export function resolveInstalledPrefixDirFromCliPath(cliPath: string, platform = process.platform) {
  const resolvedCliPath =
    platform === "win32" ? normalizeWindowsInstalledCliPath(cliPath) : cliPath;
  if (!resolvedCliPath?.trim()) {
    throw new Error("Missing installed CLI path.");
  }
  if (platform === "win32") {
    return pathWin32.dirname(resolvedCliPath);
  }
  return dirname(dirname(resolvedCliPath));
}

export async function installTarballPackage(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  tgzPath: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
  restoreBundledPluginPostinstall?: boolean;
}) {
  await installPackageSpec({
    lane: params.lane,
    env: params.env,
    packageSpec: params.tgzPath,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    ignoreScripts: params.ignoreScripts,
  });
  if (params.restoreBundledPluginPostinstall !== false) {
    await runBundledPluginPostinstall({
      lane: params.lane,
      env: params.env,
      logPath: params.logPath,
    });
  }
}

export async function installPackageSpec(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  packageSpec: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
  retryWindowsRemoval?: boolean;
}) {
  const installEnv = {
    ...params.env,
    npm_config_global: "true",
    npm_config_location: "global",
    npm_config_prefix: params.lane.prefixDir,
  };
  const retryRemoval = params.retryWindowsRemoval && process.platform === "win32";
  // Antivirus and delayed DLL handle release can outlast taskkill. Retry only
  // removal, never npm, for at most 15.5 seconds of backoff after tree exit.
  const removalRetryDelaysMs = retryRemoval ? [500, 1_000, 2_000, 4_000, 8_000] : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(installedPackageRoot(params.lane.prefixDir), { force: true, recursive: true });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "unknown";
      const retryDelayMs =
        code === "EPERM" || code === "EBUSY" ? removalRetryDelaysMs[attempt] : undefined;
      if (retryRemoval) {
        appendFileSync(
          params.logPath,
          `[release-checks] package-removal attempt=${attempt + 1} code=${code} ${retryDelayMs === undefined ? "failed" : `retryDelayMs=${retryDelayMs}`}\n`,
        );
      }
      if (retryDelayMs === undefined) {
        throw error;
      }
      await sleep(retryDelayMs);
      continue;
    }
    if (retryRemoval) {
      appendFileSync(
        params.logPath,
        `[release-checks] package-removal attempt=${attempt + 1} success\n`,
      );
    }
    break;
  }
  await withNpmDiagnostics(params.lane.homeDir, params.logPath, installEnv, async () => {
    await runCommand(
      npmCommand(),
      buildNpmGlobalInstallArgs(params.packageSpec, { ignoreScripts: params.ignoreScripts }),
      {
        cwd: params.lane.homeDir,
        env: installEnv,
        logPath: params.logPath,
        timeoutMs: params.timeoutMs ?? installTimeoutMs(),
      },
    );
  });
}

const NPM_DIAGNOSTIC_LOG_LIMIT = 8;
const NPM_DIAGNOSTIC_ERROR_CODES = new Set([
  "EACCES",
  "EBADENGINE",
  "EBUSY",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EINTEGRITY",
  "EISDIR",
  "ENOENT",
  "ENOSPC",
  "ENOTEMPTY",
  "ENOTFOUND",
  "EPERM",
  "ERESOLVE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "E401",
  "E403",
  "E404",
]);

export async function withNpmDiagnostics<T>(
  homeDir: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
) {
  const findLogs = () => resolveNpmDebugLogDirs(homeDir, env).flatMap(findNpmDebugLogs);
  const before = new Map(findLogs().map((file) => [file.path, file]));
  try {
    return await run();
  } finally {
    try {
      const changed = [...new Map(findLogs().map((file) => [file.path, file])).values()]
        .filter((file) => {
          const previous = before.get(file.path);
          return !previous || file.size !== previous.size || file.mtimeMs !== previous.mtimeMs;
        })
        .toSorted(
          (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
        );
      // Capture before the next npm invocation rotates logs. Never export npm's
      // free text: its redactor does not cover provider keys or URL query secrets.
      const logs = changed.slice(-NPM_DIAGNOSTIC_LOG_LIMIT).map((file) => {
        const previousSize = before.get(file.path)?.size ?? 0;
        const offsetBytes = previousSize <= file.size ? previousSize : 0;
        const maxBytes = CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES / NPM_DIAGNOSTIC_LOG_LIMIT;
        const truncated = file.size - offsetBytes > maxBytes;
        const window = readLogTextWindow(file.path, { maxBytes, offsetBytes });
        const text = truncated ? window.replace(/^[^\n]*(?:\n|$)/u, "") : window;
        return Object.assign(projectNpmDebugLog(text), { truncated });
      });
      appendFileSync(
        logPath,
        `\n[release-checks] npm-diagnostics ${JSON.stringify({
          logs,
          truncated: changed.length > NPM_DIAGNOSTIC_LOG_LIMIT,
        })}\n`,
        "utf8",
      );
    } catch {
      // Diagnostics must not replace the install result or original failure.
    }
  }
}

function projectNpmDebugLog(text: string) {
  const fetch = { count: 0, cacheHits: 0, cacheMisses: 0, durationMs: 0, maxDurationMs: 0 };
  const errorCodes = new Set<string>();
  let command: string | null = null;
  let exitCode: number | null = null;
  let lastActivity: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    command =
      line.match(
        /^\d+ verbose title npm (install|i|root|view|pack|exec|rebuild|run-script|--version)(?:\s|$)/u,
      )?.[1] ?? command;
    lastActivity =
      line.match(
        /^\d+ (?:silly|verbose|http|info|warn|error) (fetch manifest|idealTree|reify|tar|run|fetch|cache)\b/u,
      )?.[1] ?? lastActivity;
    const exit = line.match(/^\d+ verbose exit (-?\d{1,3})$/u);
    if (exit) {
      exitCode = Number(exit[1]);
    }
    const code = line.match(/^\d+ (?:error|verbose) code (\S+)$/u)?.[1];
    if (code && NPM_DIAGNOSTIC_ERROR_CODES.has(code)) {
      errorCodes.add(code);
    }
    // npm-registry-fetch emits both network and cache reads; summed durations
    // describe this bounded tail and may overlap, so they are not wall time.
    const request = line.match(
      /^\d+ http (?:fetch|cache) .+ (\d+)ms(?: attempt #\d+)?(?: \(cache (hit|miss|updated|revalidated|stale)\))?$/u,
    );
    if (request && isNpmTiming(Number(request[1]))) {
      const durationMs = Number(request[1]);
      fetch.count++;
      fetch.cacheHits += Number(request[2] === "hit");
      fetch.cacheMisses += Number(request[2] === "miss");
      fetch.durationMs += durationMs;
      fetch.maxDurationMs = Math.max(fetch.maxDurationMs, durationMs);
    }
  }
  return { command, exitCode, lastActivity, errorCodes: [...errorCodes], fetch };
}

function isNpmTiming(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 60 * 60 * 1000;
}

export function resolveNpmDebugLogDirs(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const configuredLogsDir = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_logs_dir ?? env.NPM_CONFIG_LOGS_DIR,
    platform,
  );
  const configuredCache = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_cache ?? env.NPM_CONFIG_CACHE,
    platform,
  );
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  const logDirs = [
    configuredLogsDir,
    configuredCache ? normalizeNpmCacheLogDir(configuredCache) : "",
    platform === "win32" && localAppData ? join(localAppData, "npm-cache", "_logs") : "",
    join(homeDir, ".npm", "_logs"),
  ].filter(Boolean);
  return [...new Set(logDirs)];
}

function resolveNpmConfiguredPath(
  homeDir: string,
  value: string | undefined,
  platform: NodeJS.Platform,
) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return "";
  }
  return platform === "win32" ? pathWin32.resolve(homeDir, raw) : resolve(homeDir, raw);
}

function normalizeNpmCacheLogDir(logDir: string) {
  return logDir.endsWith("/_logs") || logDir.endsWith("\\_logs") ? logDir : join(logDir, "_logs");
}

function findNpmDebugLogs(logsDir: string) {
  try {
    return readdirSync(logsDir).flatMap((fileName) => {
      if (!/-debug-\d+\.log$/u.test(fileName)) {
        return [];
      }
      const path = join(logsDir, fileName);
      try {
        const stat = statSync(path);
        return stat.isFile() ? [{ path, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function buildNpmGlobalInstallArgs(
  packageSpec: string,
  options: { ignoreScripts?: boolean } = {},
) {
  return [
    "install",
    "-g",
    packageSpec,
    "--omit=dev",
    "--no-fund",
    "--no-audit",
    ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
    "--loglevel=notice",
  ];
}

export async function runBundledPluginPostinstall(params: LaneCommandParams) {
  const packageRoot = installedPackageRoot(params.lane.prefixDir);
  const scriptPath = join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
  if (!existsSync(scriptPath)) {
    return;
  }
  const installEnv = {
    ...params.env,
  };
  delete installEnv.OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL;
  delete installEnv.NPM_CONFIG_PREFIX;
  delete installEnv.npm_config_global;
  delete installEnv.npm_config_location;
  delete installEnv.npm_config_prefix;

  await runCommand(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: installEnv,
    logPath: params.logPath,
    timeoutMs: 20 * 60 * 1000,
  });
}

export function shouldRunWindowsInstalledBrowserOverrideImportSmoke(platform = process.platform) {
  return platform === "win32";
}

export function buildInstalledBrowserOverrideImportProbeScript(
  runtimeModuleSpecifier = "openclaw/plugin-sdk/plugin-runtime",
) {
  return `
import { existsSync } from "node:fs";
import { startLazyPluginServiceModule } from ${JSON.stringify(runtimeModuleSpecifier)};

const startedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH;
const stoppedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH;

if (!process.env.OPENCLAW_BROWSER_CONTROL_MODULE) {
  throw new Error("Missing OPENCLAW_BROWSER_CONTROL_MODULE.");
}
if (!startedPath || !stoppedPath) {
  throw new Error("Missing browser override sentinel path env.");
}

const handle = await startLazyPluginServiceModule({
  overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
  validateOverrideSpecifier: (specifier) => specifier,
  loadDefaultModule: async () => {
    throw new Error("Default browser control service should not load during override probe.");
  },
  startExportNames: ["startBrowserControlService"],
  stopExportNames: ["stopBrowserControlService"],
});

if (!handle) {
  throw new Error("Browser control override probe did not return a service handle.");
}
if (!existsSync(startedPath)) {
  throw new Error("Browser control override start sentinel was not written.");
}

await handle.stop();

if (!existsSync(stoppedPath)) {
  throw new Error("Browser control override stop sentinel was not written.");
}

console.log("windows browser override import OK");
`.trim();
}

function buildBrowserOverrideProbeServiceModule() {
  return `
import { writeFileSync } from "node:fs";

export async function startBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH, "started\\n", "utf8");
}

export async function stopBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH, "stopped\\n", "utf8");
}
`.trim();
}

export async function runInstalledBrowserOverrideImportSmoke(
  params: LaneCommandParams & { prefixDir: string },
) {
  if (!shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
    return "skipped";
  }

  const probeDir = join(params.lane.rootDir, "browser override import probe");
  mkdirSync(probeDir, { recursive: true });
  const overridePath = join(probeDir, "browser override #module.mjs");
  const probePath = join(probeDir, "run browser override probe.mjs");
  const startedPath = join(probeDir, "started.txt");
  const stoppedPath = join(probeDir, "stopped.txt");
  const packageRoot = installedPackageRoot(params.prefixDir);
  const runtimeModulePath = join(packageRoot, "dist", "plugin-sdk", "plugin-runtime.js");
  if (!existsSync(runtimeModulePath)) {
    throw new Error(`Installed browser runtime module not found: ${runtimeModulePath}`);
  }

  writeFileSync(overridePath, `${buildBrowserOverrideProbeServiceModule()}\n`, "utf8");
  writeFileSync(
    probePath,
    `${buildInstalledBrowserOverrideImportProbeScript(pathToFileURL(runtimeModulePath).href)}\n`,
    "utf8",
  );

  await runCommand(process.execPath, [probePath], {
    cwd: packageRoot,
    env: {
      ...params.env,
      OPENCLAW_BROWSER_CONTROL_MODULE: pathToFileURL(overridePath).href,
      OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH: startedPath,
      OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH: stoppedPath,
    },
    logPath: params.logPath,
    timeoutMs: 60_000,
  });

  if (!existsSync(startedPath) || !existsSync(stoppedPath)) {
    throw new Error("Browser control override import probe did not write both sentinels.");
  }

  return "pass";
}

export function ensureLocalNpmShim(lane: LaneState) {
  const shimPath = npmShimPath(lane.prefixDir);
  if (existsSync(shimPath)) {
    return;
  }
  mkdirSync(dirname(shimPath), { recursive: true });
  const resolvedNpm = resolveCommandPath(npmCommand());
  if (!resolvedNpm) {
    throw new Error(`Failed to resolve ${npmCommand()} on PATH.`);
  }
  if (process.platform === "win32") {
    writeFileSync(
      shimPath,
      `@echo off\r\nset "NPM_CONFIG_PREFIX=${lane.prefixDir}"\r\n"${resolvedNpm}" %*\r\n`,
      "utf8",
    );
    return;
  }
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexport NPM_CONFIG_PREFIX='${shellEscapeForSh(lane.prefixDir)}'\nexec '${shellEscapeForSh(resolvedNpm)}' "$@"\n`,
    "utf8",
  );
  chmodSync(shimPath, 0o755);
}

function readInstalledPackageManifestFromPackageRoot(packageRoot: string) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package manifest missing: ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  return { packageJson, packageRoot };
}

export function readInstalledVersion(prefixDir: string) {
  const { packageJson } = readInstalledPackageManifestFromPackageRoot(
    installedPackageRoot(prefixDir),
  );
  return typeof packageJson.version === "string" ? packageJson.version.trim() : "";
}

export function readInstalledMetadataFromCliPath(cliPath: string, platform = process.platform) {
  return readInstalledMetadataFromPackageRoot(
    resolveInstalledPackageRootFromCliPath(cliPath, platform),
  );
}

export function readInstalledMetadata(prefixDir: string) {
  return readInstalledMetadataFromPackageRoot(installedPackageRoot(prefixDir));
}

function readInstalledMetadataFromPackageRoot(packageRoot: string) {
  const { packageJson } = readInstalledPackageManifestFromPackageRoot(packageRoot);
  const buildInfoPath = join(packageRoot, "dist", "build-info.json");
  if (!existsSync(buildInfoPath)) {
    throw new Error(`Installed build info missing: ${buildInfoPath}`);
  }
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
    commit?: unknown;
  };
  return {
    version: typeof packageJson.version === "string" ? packageJson.version.trim() : "",
    commit: typeof buildInfo.commit === "string" ? buildInfo.commit.trim() : "",
  };
}

export function verifyInstalledCandidate(
  installed: { version: string; commit: string },
  build: CandidateBuild,
) {
  if (installed.version !== build.candidateVersion) {
    throw new Error(
      `Installed version mismatch. Expected ${build.candidateVersion}, found ${installed.version || "<missing>"}.`,
    );
  }
  if (installed.commit !== build.sourceSha) {
    throw new Error(
      `Installed build commit mismatch. Expected ${build.sourceSha}, found ${installed.commit || "<missing>"}.`,
    );
  }
}

export function resolveInstalledPackageRootFromCliPath(
  cliPath: string,
  platform = process.platform,
  env = process.env,
) {
  const prefixDir = resolveInstalledPrefixDirFromCliPath(cliPath, platform);
  const candidates = [installedPackageRoot(prefixDir, platform)];

  if (platform !== "win32") {
    const resolvedCliPath = cliPath.trim();
    if (resolvedCliPath) {
      try {
        const realCliPath = realpathSync(resolvedCliPath);
        candidates.push(dirname(realCliPath));
        candidates.push(dirname(dirname(realCliPath)));
      } catch {
        // Some installer shims are shell wrappers, not symlinks. Fall through to
        // common user-local npm prefixes below.
      }
    }

    for (const prefix of [
      env.NPM_CONFIG_PREFIX,
      env.npm_config_prefix,
      env.HOME && join(env.HOME, ".npm-global"),
      env.HOME && join(env.HOME, ".local"),
    ]) {
      if (typeof prefix === "string" && prefix.trim()) {
        candidates.push(installedPackageRoot(prefix, platform));
      }
    }
  }

  const checked: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || checked.includes(candidate)) {
      continue;
    }
    checked.push(candidate);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`Installed package manifest missing. Checked: ${checked.join(", ")}`);
}

function installedPackageRoot(prefixDir: string, platform = process.platform) {
  return platform === "win32"
    ? join(prefixDir, "node_modules", "openclaw")
    : join(prefixDir, "lib", "node_modules", "openclaw");
}

export function installedEntryPath(prefixDir: string) {
  return join(installedPackageRoot(prefixDir), "openclaw.mjs");
}

function npmShimPath(prefixDir: string) {
  return process.platform === "win32" ? join(prefixDir, "npm.cmd") : join(prefixDir, "bin", "npm");
}

export function binDirForPrefix(prefixDir: string) {
  return process.platform === "win32" ? prefixDir : join(prefixDir, "bin");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

export function resolvePublishedInstallerUrl(platform = process.platform) {
  if (platform === "win32") {
    return `${PUBLISHED_INSTALLER_BASE_URL}/install.ps1`;
  }
  return `${PUBLISHED_INSTALLER_BASE_URL}/install.sh`;
}
