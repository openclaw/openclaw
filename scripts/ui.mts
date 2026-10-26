#!/usr/bin/env node
// Routes UI package commands through the repo's Node/pnpm wrappers.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPidDefinitelyDead } from "../src/shared/pid-alive.ts";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import {
  assertRealOutputRoot,
  CONTROL_UI_BUILD_PREFIX,
  controlUiBuildSiblingPid,
} from "./lib/output-root-guard.mjs";
import { prepareControlUiSettings } from "./lib/prepare-control-ui-settings.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";
import { resolveNodePackageBin } from "./run-node-package-bin.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");
const requireFromUi = createRequire(path.join(uiDir, "package.json"));

const FORWARDED_SIGNAL_KILL_GRACE_MS = 250;
const PUBLISH_RENAME_DELAYS_MS = [100, 200, 400, 800, 1600];
const PUBLISH_RENAME_WAIT = new Int32Array(new SharedArrayBuffer(4));

type UiBuildEnvironmentSources = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readBuildInfo?: () => unknown;
  readGitCommit?: () => string | null;
  readPackageVersion?: () => string | null;
};

function readCurrentGitCommit(): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readCurrentPackageVersion(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function readExistingBuildInfo(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "dist/build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Reuse a matching runtime identity for a standalone rebuild of the bundled UI. */
export function resolveUiBuildEnvironment(
  sources: UiBuildEnvironmentSources = {},
): NodeJS.ProcessEnv {
  const env = sources.env ?? process.env;
  const buildEnv = resolveBuildIdentityEnvironment({
    commitLabel: "Control UI build commit",
    env,
    now: sources.now,
    readGitCommit: sources.readGitCommit ?? readCurrentGitCommit,
  });
  if (env.OPENCLAW_BUILD_TIMESTAMP?.trim() || env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim()) {
    return buildEnv;
  }

  const existing = normalizeControlUiBuildInfo((sources.readBuildInfo ?? readExistingBuildInfo)());
  const version = (sources.readPackageVersion ?? readCurrentPackageVersion)();
  const release = env.OPENCLAW_CONTROL_UI_RELEASE_BUILD?.trim() === "1";
  if (
    existing.buildId === "dev" ||
    !existing.builtAt ||
    existing.commit !== buildEnv.GIT_COMMIT ||
    existing.version !== version ||
    existing.release !== release
  ) {
    return buildEnv;
  }
  return {
    ...buildEnv,
    OPENCLAW_BUILD_TIMESTAMP: existing.builtAt,
    OPENCLAW_CONTROL_UI_BUILD_ID: existing.buildId,
  };
}

type UiSpawnCall = ReturnType<typeof createPnpmRunnerSpawnSpec>;

type UiSpawnParams = {
  comSpec?: string;
  cwd?: string;
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
};

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

function usage(): void {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write("Usage: node scripts/ui.js <install|dev|build|test> [...args]\n");
}

function resolveSpawnCall(
  cmd: string,
  args: string[],
  envOverride?: NodeJS.ProcessEnv,
  params: UiSpawnParams = {},
): UiSpawnCall {
  const options: UiSpawnCall["options"] = {
    cwd: params.cwd ?? uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    shell: false,
    detached: undefined,
    windowsVerbatimArguments: undefined,
  };

  return {
    command: cmd,
    args,
    options,
  };
}

export function resolvePnpmSpawnCall(
  pnpmArgs: string[],
  envOverride?: NodeJS.ProcessEnv,
  params: UiSpawnParams = {},
): UiSpawnCall {
  return createPnpmRunnerSpawnSpec({
    ...params,
    cwd: params.cwd ?? uiDir,
    env: envOverride ?? process.env,
    pnpmArgs,
    stdio: "inherit",
  });
}

function runSpawnCall(spawnCall: UiSpawnCall, label: string): void {
  const { command, args: spawnArgs, options } = spawnCall;
  let child;
  try {
    child = spawn(command, spawnArgs, options);
  } catch (err) {
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
    return;
  }

  const forwardedSignals = ["SIGTERM", "SIGHUP"] as const;
  let forwardedSignal: (typeof forwardedSignals)[number] | null = null;
  let forwardedSignalPids: number[] = [];
  let forwardedSignalTreeComplete = false;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let forcedSignalCleanup = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let forwardedSignalDrainTimer: ReturnType<typeof setInterval> | null = null;
  const clearForwardedSignalTimers = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    if (forwardedSignalDrainTimer) {
      clearInterval(forwardedSignalDrainTimer);
      forwardedSignalDrainTimer = null;
    }
  };
  const finishForwardedSignal = () => {
    if (!forwardedSignal || !childExit) {
      return;
    }
    cleanupSignalHandlers();
    const interrupted =
      childExit.signal ??
      (forcedSignalCleanup ? "SIGKILL" : !forwardedSignalTreeComplete ? forwardedSignal : null);
    if (interrupted) {
      process.kill(process.pid, interrupted);
      return;
    }
    // A returned child and quiescent captured tree acknowledge this stop.
    // Raw signal death and forced cleanup cannot make that same promise.
    process.exit(forwardedSignal === "SIGTERM" ? 143 : 129);
  };
  const waitForForwardedSignalChildren = () => {
    if (!forwardedSignal || !childExit || processTreeIsAlive(forwardedSignalPids)) {
      return;
    }
    finishForwardedSignal();
  };
  // Keep UI dev children in the foreground process group for native TTY
  // resize/job-control behavior. Forward wrapper shutdown signals to the
  // captured child tree instead of using a detached process group.
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        if (!forwardedSignal) {
          forwardedSignal = signal;
          const tree = collectChildProcessTreePids(child);
          forwardedSignalPids = tree.pids;
          forwardedSignalTreeComplete = tree.complete;
          signalProcessTree(child, signal, forwardedSignalPids);
          forwardedSignalDrainTimer = setInterval(waitForForwardedSignalChildren, 25);
          forceKillTimer = setTimeout(() => {
            if (processTreeIsAlive(forwardedSignalPids)) {
              forcedSignalCleanup = true;
              signalProcessTree(child, "SIGKILL", forwardedSignalPids);
            }
          }, FORWARDED_SIGNAL_KILL_GRACE_MS);
          forceKillTimer.unref?.();
        }
      },
    ]),
  );
  const cleanupSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    clearForwardedSignalTimers();
  };
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  child.on("error", (err) => {
    cleanupSignalHandlers();
    console.error(`Failed to launch ${label}:`, err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
    if (forwardedSignal) {
      forwardedSignalPids = forwardedSignalPids.filter((pid) => pid !== child.pid);
      waitForForwardedSignalChildren();
      return;
    }
    cleanupSignalHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function collectChildProcessTreePids(child: ChildProcess): { pids: number[]; complete: boolean } {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return { pids: typeof child.pid === "number" ? [child.pid] : [], complete: false };
  }
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) {
    return { pids: [child.pid], complete: false };
  }
  const childrenByParent = new Map<number, number[]>();
  let complete = true;
  let childFound = false;
  for (const line of ps.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) {
      if (line.trim()) {
        complete = false;
      }
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    childFound ||= pid === child.pid;
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  const pids = [child.pid];
  for (const parentPid of pids) {
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      pids.push(pid);
    }
  }
  return { pids: [...new Set(pids)], complete: complete && childFound };
}

function processTreeIsAlive(pids: number[]): boolean {
  return pids.some((pid) => !isPidDefinitelyDead(pid));
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, pids: number[]): void {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  if (pids.length === 0) {
    child.kill(signal);
    return;
  }
  for (const pid of pids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
}

type UiSpawnResult = { status: number | null; signal: NodeJS.Signals | null };

function runSpawnCallSync(spawnCall: UiSpawnCall, label: string): UiSpawnResult {
  const { command, args: spawnArgs, options } = spawnCall;
  try {
    return spawnSync(command, spawnArgs, options);
  } catch (err) {
    console.error(`Failed to launch ${label}:`, err);
    return { status: 1, signal: null };
  }
}

function exitForSpawnResult(result: UiSpawnResult): void {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function removeUiBuildDirectory(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    // Preserve the build outcome; a later build can reclaim locked leftovers.
    console.warn(`Could not remove temporary Control UI output ${directory}:`, error);
  }
}

function renameWithRetry(from: string, to: string): void {
  // Windows scanners/indexers can transiently deny freshly written or served trees.
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const delay = PUBLISH_RENAME_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !["EPERM", "EACCES", "EBUSY"].some((code) => hasErrorCode(error, code))
      ) {
        throw error;
      }
      Atomics.wait(PUBLISH_RENAME_WAIT, 0, 0, delay);
    }
  }
}

function normalizeUiBuildPermissions(directory: string): void {
  fs.chmodSync(directory, 0o755);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeUiBuildPermissions(entryPath);
    } else if (entry.isFile()) {
      fs.chmodSync(entryPath, 0o644);
    }
  }
}

async function buildAndPublishUi(
  toolCall: UiSpawnCall,
  env: NodeJS.ProcessEnv,
): Promise<UiSpawnResult> {
  const validation = runSpawnCallSync(
    resolveSpawnCall(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(here, "tsx.mjs")).href,
        path.join(here, "generate-control-ui-validators.mts"),
        "--check",
      ],
      env,
      { cwd: repoRoot },
    ),
    "Control UI protocol validators",
  );
  if (validation.signal || validation.status !== 0) {
    return validation;
  }
  // Prepare before cache input capture: presenter source edits must change the
  // canonical bytes and inventory even when the UI bundle can otherwise be reused.
  await prepareControlUiSettings(repoRoot);
  const dist = path.join(repoRoot, "dist");
  const output = path.join(dist, "control-ui");
  fs.mkdirSync(dist, { recursive: true });
  if (!fs.existsSync(output)) {
    // An interrupted swap can leave the previous complete build in a retired sibling.
    const retired = fs
      .readdirSync(dist)
      .filter((name) => {
        const pid = controlUiBuildSiblingPid(name);
        return name.endsWith(".retired") && pid !== null && isPidDefinitelyDead(pid);
      })
      .map((name) => path.join(dist, name))
      .toSorted((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
    if (retired) {
      renameWithRetry(retired, output);
    }
  }
  for (const name of fs.readdirSync(dist)) {
    const pid = controlUiBuildSiblingPid(name);
    if (pid !== null && isPidDefinitelyDead(pid)) {
      removeUiBuildDirectory(path.join(dist, name));
    }
  }
  const staging = fs.mkdtempSync(path.join(dist, `${CONTROL_UI_BUILD_PREFIX}${process.pid}-`));
  const retired = `${staging}.retired`;
  try {
    const validator = (script: string, ...args: string[]): [UiSpawnCall, string] => [
      resolveSpawnCall(process.execPath, [path.join(here, script), ...args], env, {
        cwd: repoRoot,
      }),
      script,
    ];
    const cache =
      env.OPENCLAW_BUILD_CACHE !== "0" && toolCall.args.length === 2 && toolCall.args[1] === "build"
        ? await import("./lib/build-artifact-cache.mts")
        : undefined;
    const sourcePluginInventory =
      cache && env.OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS === "1"
        ? (await import("./lib/bundled-plugin-build-entries.mjs"))
            .collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot, env })
            .map(({ id, isolated, packageJson }) => {
              const openclaw =
                isRecord(packageJson) && isRecord(packageJson.openclaw)
                  ? packageJson.openclaw
                  : undefined;
              return [id, isolated, openclaw?.controlUi];
            })
        : undefined;
    const step = {
      label: "ui:build",
      cache: {
        inputs: [
          { path: "ui", excludeDirectories: ["node_modules"] },
          { path: "packages", excludeDirectories: ["node_modules", "dist", ".artifacts"] },
          ...fs
            .readdirSync(path.join(repoRoot, "scripts/lib"))
            .filter((file) => file.startsWith("control-ui-i18n"))
            .map((file) => `scripts/lib/${file}`),
          "scripts/ui.js",
          "scripts/ui.mts",
          "scripts/pnpm-runner.mts",
          "scripts/run-node-package-bin.mts",
          "scripts/lib/build-artifact-cache.mts",
          "scripts/lib/output-root-guard.mjs",
          "scripts/lib/build-identity.mts",
          "package.json",
          "pnpm-lock.yaml",
          "tsconfig.json",
          // Poster generation reads bundled fonts outside the UI source tree.
          "src/gateway/assets/session-card/Lato-Regular.ttf",
          "src/gateway/assets/session-card/InstrumentSerif-Regular.ttf",
          // Package metadata discovers new generations; all copied files (including
          // deferred chunks absent from Vite's module graph) invalidate reuse.
          ...(() => {
            const root = path.join(repoRoot, "dist/extensions");
            if (!fs.existsSync(root)) {
              return [];
            }
            return fs
              .readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .flatMap((entry) => {
                const relative = `dist/extensions/${entry.name}`;
                return [
                  `${relative}/package.json`,
                  `${relative}/openclaw.plugin.json`,
                  `${relative}/dist/control-ui`,
                ];
              });
          })(),
        ],
        outputs: ["."],
        requiredOutputs: ["index.html", "sw.js", ".build-inputs.json"],
        restore: "always" as const,
      },
    };
    const staticInputs = cache?.listCacheFiles(repoRoot, step.cache.inputs, fs) ?? [];
    const inputSignature = (inputs: string[]) =>
      cache!.hashInputFiles(
        repoRoot,
        [
          ...new Set([...staticInputs, ...inputs.map((file) => path.join(repoRoot, file))]),
        ].toSorted(),
        fs,
        [
          "NODE_ENV",
          "OPENCLAW_CONTROL_UI_BASE_PATH",
          "OPENCLAW_CONTROL_UI_RELEASE_BUILD",
          "OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS",
        ],
        env,
        JSON.stringify({
          args: toolCall.args.slice(1),
          platform: process.platform,
          arch: process.arch,
          sourcePluginInventory,
        }),
      );
    const cacheState = cache?.resolveBuildStepCacheState(step, {
      rootDir: repoRoot,
      artifactRoot: output,
      env,
      inputSignature,
    });
    const reuseOutput =
      cacheState?.fresh &&
      cache?.restoreBuildStepCacheOutputs(cacheState, {
        rootDir: repoRoot,
        artifactRoot: staging,
        staging: true,
      });
    if (reuseOutput) {
      const { runnerImport } = await import("vite");
      const {
        module: { refreshControlUiBuildOutput, resolveControlUiBuildInfo },
      } = await runnerImport<typeof import("../ui/vite.config.ts")>(
        path.join(uiDir, "vite.config.ts"),
        { configFile: false },
      );
      await refreshControlUiBuildOutput(staging, resolveControlUiBuildInfo({ env }));
      console.log("Control UI build: reused content cache; refreshed release identity");
    }
    const calls: [UiSpawnCall, string][] = [
      ...(!reuseOutput
        ? ([
            [
              {
                ...toolCall,
                options: {
                  ...toolCall.options,
                  env: {
                    ...toolCall.options.env,
                    OPENCLAW_CONTROL_UI_PREPARED_SETTINGS_ROOT: repoRoot,
                  },
                },
                args: distArtifactEntryArgs(
                  toolCall.args[0]!,
                  [...toolCall.args.slice(1), "--outDir", staging],
                  { native: true },
                ),
              },
              "Control UI build",
            ],
          ] satisfies [UiSpawnCall, string][])
        : []),
      validator("check-control-ui-precompressed-assets.mts", staging),
      validator("check-control-ui-performance.mts", "--report-only", "--dist", staging),
    ];
    for (const [call, label] of calls) {
      const result = runSpawnCallSync(call, label);
      if (result.signal || result.status !== 0) {
        return result;
      }
    }
    // A cache hit refreshes identity only in staging; its validated seed is immutable.
    if (cache && cacheState && !reuseOutput) {
      const consumedInputs: string[] = JSON.parse(
        fs.readFileSync(path.join(staging, ".build-inputs.json"), "utf8"),
      );
      cache.finalizeBuildStepCache(
        step,
        {
          ...cacheState,
          consumedInputs,
          signature: inputSignature(consumedInputs),
        },
        { rootDir: repoRoot, artifactRoot: staging, env },
      );
    }
    normalizeUiBuildPermissions(staging);
    const hadOutput = fs.existsSync(output);
    if (hadOutput) {
      renameWithRetry(output, retired);
    }
    try {
      renameWithRetry(staging, output);
    } catch (error) {
      if (hadOutput) {
        renameWithRetry(retired, output);
      }
      throw new Error("Failed to publish Control UI build; previous output retained.", {
        cause: error,
      });
    }
    removeUiBuildDirectory(retired);
    return { status: 0, signal: null };
  } finally {
    removeUiBuildDirectory(staging);
  }
}

function depsInstalled(kind: "build" | "test"): boolean {
  try {
    requireFromUi.resolve("vite");
    requireFromUi.resolve("dompurify");
    if (kind === "test") {
      requireFromUi.resolve("vitest");
      requireFromUi.resolve("@vitest/browser-playwright");
      requireFromUi.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

function resolveScriptAction(action: string): [tool: "vite" | "vitest", ...args: string[]] | null {
  if (action === "dev") {
    return ["vite"];
  }
  if (action === "build") {
    return ["vite", "build"];
  }
  if (action === "test") {
    return ["vitest", "run", "--config", "vitest.config.ts"];
  }
  return null;
}

export async function runUiCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
    process.exit(2);
  }

  const script = resolveScriptAction(action);
  if (action !== "install" && !script) {
    usage();
    process.exit(2);
  }
  if (action === "build") {
    assertRealOutputRoot(path.join(repoRoot, "dist"));
    assertRealOutputRoot(path.join(repoRoot, "dist/control-ui"));
  }

  if (action === "install") {
    runSpawnCall(resolvePnpmSpawnCall(["install", ...rest]), "pnpm");
    return;
  }
  if (!script) {
    return;
  }

  const noPnpmBuild = action === "build" && process.env.OPENCLAW_BUILD_ALL_NO_PNPM === "1";
  if (!noPnpmBuild && !depsInstalled(action === "test" ? "test" : "build")) {
    exitForSpawnResult(runSpawnCallSync(resolvePnpmSpawnCall(["install"]), "pnpm"));
  }

  const [tool, ...args] = script;
  const env = action === "build" ? resolveUiBuildEnvironment() : process.env;
  const toolCall = resolveSpawnCall(
    process.execPath,
    [resolveNodePackageBin(tool, requireFromUi), ...args, ...rest],
    env,
  );
  if (action === "build") {
    exitForSpawnResult(
      rest.some((arg) => arg === "--help" || arg === "-h")
        ? runSpawnCallSync(toolCall, "Control UI build")
        : await withDistArtifactOwnership(repoRoot, () => buildAndPublishUi(toolCall, env)),
    );
    return;
  }

  runSpawnCall(toolCall, tool);
}

function resolveDirectExecutionPath(
  entry: string,
  realpath: (filePath: string) => string = fs.realpathSync.native,
): string {
  const resolved = path.resolve(entry);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function isDirectScriptExecution(
  entry: string | undefined = process.argv[1],
  scriptPath: string = fileURLToPath(import.meta.url),
  realpath: (filePath: string) => string = fs.realpathSync.native,
): boolean {
  if (!entry) {
    return false;
  }
  return (
    resolveDirectExecutionPath(entry, realpath) === resolveDirectExecutionPath(scriptPath, realpath)
  );
}

const isDirectExecution = isDirectScriptExecution();

if (isDirectExecution) {
  await runUiCli();
}
