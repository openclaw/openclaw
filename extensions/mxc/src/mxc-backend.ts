import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import type {
  SandboxBackendHandle,
  SandboxBackendExecSpec,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  CreateSandboxBackendParams,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import type { MxcConfig } from "./config.js";
import { createMxcFsBridge } from "./fs-bridge.js";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import {
  computeEffectiveReadonlyPaths,
  computeEffectiveReadwritePaths,
  resolveSandboxTempDir,
  type BaselineHostEnv,
  type SandboxBaselinePolicy,
} from "./sandbox-baseline.js";
import { loadSandboxBaselinePolicy } from "./sandbox-policy-loader.js";
import { buildCommandLine, createWindowsCommandBridge } from "./windows-command.js";
import { buildLauncherEnv, normalizeWindowsProcessEnvRecord } from "./windows-env.js";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcReadOnlySkillMount,
  type MxcWorkspaceAccess,
} from "./workspace-skill-mounts.js";

type MxcContainerConfig = {
  version: string;
  containerId: string;
  containment: string;
  lifecycle: { destroyOnExit: boolean };
  process: {
    commandLine: string;
    cwd: string;
    env: string[];
    timeout: number;
  };
  filesystem: {
    deniedPaths?: string[];
    readwritePaths?: string[];
    readonlyPaths?: string[];
    clearPolicyOnExit?: boolean;
  };
  ui: {
    disable: boolean;
    clipboard: "none";
    injection: false;
  };
  network: {
    defaultPolicy: "allow" | "block";
    enforcementMode?: "capabilities";
  };
  processContainer?: {
    name: string;
    leastPrivilege: boolean;
    capabilities: string[];
    ui: {
      isolation: "container";
      desktopSystemControl: false;
      systemSettings: "none";
      ime: false;
    };
  };
};

type MxcLauncherOptions = {
  debug: boolean;
  executablePath?: string;
  usePty?: boolean;
};

const MXC_SCHEMA_VERSION = "0.7.0-alpha";
const PROCESS_CONTAINER_NAME_MAX_LEN = 64;

type MxcExecFinalizeToken = {
  payloadDir: string;
  sandboxTempDir?: string;
};

function sanitizeRuntimeId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `openclaw-mxc-${slug || "sandbox"}-${hash}`;
}

// MXC containers are ephemeral (lifecycle.destroyOnExit=true) and named per invocation.
// Keep the runtimeId as the stable handle identifier (used for logs + SDK tracking) and
// derive a fresh per-call containerId from it so parallel spawns cannot collide on
// backend-specific runtime names.
const CONTAINER_ID_MAX_LEN = 80;
function uniqueContainerId(runtimeId: string): string {
  const suffix = randomBytes(4).toString("hex");
  const base =
    runtimeId.length + suffix.length + 1 > CONTAINER_ID_MAX_LEN
      ? runtimeId.slice(0, CONTAINER_ID_MAX_LEN - suffix.length - 1)
      : runtimeId;
  return `${base}-${suffix}`;
}

function createLauncherPayloadFile(
  payloadJson: string,
): MxcExecFinalizeToken & { payloadFile: string } {
  const payloadDir = mkdtempSync(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-mxc-payload-"),
  );
  const payloadFile = path.join(payloadDir, "payload.json");
  try {
    writeFileSync(payloadFile, payloadJson, { flag: "wx", mode: 0o600 });
  } catch (err) {
    rmSync(payloadDir, { force: true, recursive: true });
    throw err;
  }
  return { payloadDir, payloadFile };
}

function cleanupLauncherPayloadFile(token: unknown): void {
  if (
    token &&
    typeof token === "object" &&
    "payloadDir" in token &&
    typeof token.payloadDir === "string"
  ) {
    rmSync(token.payloadDir, { force: true, recursive: true });
    if ("sandboxTempDir" in token && typeof token.sandboxTempDir === "string") {
      rmSync(token.sandboxTempDir, { force: true, recursive: true });
    }
  }
}

function createSandboxTempDir(hostEnv: BaselineHostEnv): string {
  return mkdtempSync(path.join(resolveSandboxTempDir(hostEnv), "openclaw-mxc-sandbox-"));
}

function resolveProcessCwd(workdir: string): string {
  // Pass workdir as the sandbox's working directory. MXC's BaseContainer
  // runner grants the AppContainer SID access to this path at spawn time
  // (per readwritePaths brokering), so the child process starts inside
  // workdir without needing a script-level `cd` that the restricted token
  // would reject.
  return workdir;
}

function assertWorkdirInsideWorkspace(workspaceDir: string, workdir: string): string {
  const workspace = realpathForExistingPath(workspaceDir, "sandbox workspace");
  const candidate = realpathForPotentialPath(workdir);
  const relative = path.relative(workspace, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(
    `MXC sandbox workdir ${workdir} is outside the sandbox workspace ${workspaceDir}. ` +
      `Use a workdir inside the sandbox workspace.`,
  );
}

function resolveWorkdirInsideWorkspace(workspaceDir: string, workdir: string): string {
  const candidate = assertWorkdirInsideWorkspace(workspaceDir, workdir);
  try {
    if (statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new Error(`MXC sandbox workdir ${workdir} does not exist.`, { cause: err });
    }
    throw err;
  }
  throw new Error(`MXC sandbox workdir ${workdir} is not a directory.`);
}

function realpathForExistingPath(value: string, label: string): string {
  try {
    return realpathSync(path.resolve(value));
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      throw new Error(`MXC ${label} ${value} does not exist.`, { cause: err });
    }
    throw err;
  }
}

function realpathForPotentialPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch (err) {
    if (!isNodeError(err) || err.code !== "ENOENT") {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      throw new Error(`MXC sandbox workdir ${value} does not exist.`, { cause: err });
    }
    return path.join(realpathForPotentialPath(parent), path.basename(resolved));
  }
}

function processContainerName(runtimeId: string): string {
  if (runtimeId.length <= PROCESS_CONTAINER_NAME_MAX_LEN) {
    return runtimeId;
  }
  const hash = createHash("sha256").update(runtimeId).digest("hex").slice(0, 8);
  return `${runtimeId.slice(0, PROCESS_CONTAINER_NAME_MAX_LEN - hash.length - 1)}-${hash}`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

type BaselineApplicationContext = {
  homeDir: string;
  projectDir: string;
  hostEnv: BaselineHostEnv;
};

type MxcWorkspaceContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: MxcWorkspaceAccess;
};

function resolveMxcProtectedSkillMounts(
  context: MxcWorkspaceContext,
): readonly MxcReadOnlySkillMount[] {
  return resolveMxcReadOnlySkillMounts({
    agentWorkspaceDir: context.agentWorkspaceDir,
    skillsWorkspaceDir: context.skillsWorkspaceDir,
    workdir: context.workdir,
    workspaceAccess: context.workspaceAccess,
  });
}

function resolveMxcProtectedSkillPolicyPaths(context: MxcWorkspaceContext): string[] {
  const paths: string[] = [];
  for (const mount of resolveMxcProtectedSkillMounts(context)) {
    paths.push(path.resolve(mount.hostPath));
    const containerPath = path.resolve(mount.containerPath);
    if (containerPath !== path.resolve(mount.hostPath)) {
      paths.push(containerPath);
    }
  }
  return paths;
}

function resolveMxcWorkspaceContext(params: {
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: MxcWorkspaceAccess;
}): MxcWorkspaceContext {
  const workspaceAccess = params.workspaceAccess ?? "rw";
  return {
    workspaceDir: params.workdir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? params.workdir,
    ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
    workdir: params.workdir,
    workspaceAccess,
  };
}

function assertNoMxcReadwriteReadonlyOverlap(params: {
  readwritePaths: readonly string[];
  readonlyPaths: readonly string[];
}): void {
  for (const readwritePath of params.readwritePaths) {
    for (const readonlyPath of params.readonlyPaths) {
      if (pathsOverlap(readwritePath, readonlyPath)) {
        throw new Error(
          `MXC readwrite path ${readwritePath} overlaps read-only path ${readonlyPath}. Windows MXC cannot safely enforce nested read-only overlays under writable paths.`,
        );
      }
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const left = normalizePathForOverlap(first);
  const right = normalizePathForOverlap(second);
  return isPathWithinOrEqual(left, right) || isPathWithinOrEqual(right, left);
}

function normalizePathForOverlap(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithinOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveCurrentBaselineContext(projectDir: string): BaselineApplicationContext {
  return {
    homeDir: homedir(),
    projectDir,
    hostEnv: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ProgramFiles: process.env.ProgramFiles,
      ProgramW6432: process.env.ProgramW6432,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  };
}

function applySandboxBaselineToConfig(
  config: MxcContainerConfig,
  baseline: SandboxBaselinePolicy,
  context: BaselineApplicationContext,
  options: {
    sandboxTempDir: string;
    workspace: MxcWorkspaceContext;
  },
): MxcContainerConfig {
  const filesystem = config.filesystem;
  const readwritePaths = [...(filesystem.readwritePaths ?? [])];
  const readonlyPaths = [...(filesystem.readonlyPaths ?? [])];
  const protectedSkillPolicyPaths = resolveMxcProtectedSkillPolicyPaths(options.workspace);
  if (baseline.filesystem.restrictToProjectDir) {
    const baselineReadwritePaths = computeEffectiveReadwritePaths({
      projectDir: context.projectDir,
      sandboxTempDir: options.sandboxTempDir,
      tempEnv: context.hostEnv,
      additionalReadwritePaths: baseline.filesystem.additionalReadwritePaths,
    });
    if (options.workspace.workspaceAccess === "rw") {
      readwritePaths.push(...baselineReadwritePaths);
    } else {
      const projectDir = path.resolve(context.projectDir);
      readonlyPaths.push(projectDir);
      readwritePaths.push(
        ...baselineReadwritePaths.filter((value) => path.resolve(value) !== projectDir),
      );
    }
  }
  const resolvedReadonlyPaths = dedupeStable([
    ...readonlyPaths,
    ...protectedSkillPolicyPaths,
    ...computeEffectiveReadonlyPaths(baseline.filesystem, context.hostEnv),
  ]);
  const resolvedReadwritePaths = dedupeStable(readwritePaths);
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths: resolvedReadwritePaths,
    readonlyPaths: protectedSkillPolicyPaths,
  });

  config.filesystem = {
    ...filesystem,
    readonlyPaths: resolvedReadonlyPaths,
    deniedPaths: filesystem.deniedPaths,
    readwritePaths: resolvedReadwritePaths,
    clearPolicyOnExit: filesystem.clearPolicyOnExit ?? true,
  };

  return config;
}

// MXC always resolves `process` / `processcontainer` to a Windows
// ProcessContainer in this Windows-only plugin. The plugin only uses token
// capabilities; host allow/block rules are not exposed until MXC can enforce
// them for this backend.
function normalizeNetworkPolicyForContainment(config: MxcContainerConfig): void {
  const network = config.network;
  delete network.enforcementMode;
  network.enforcementMode = "capabilities";
}

function resolveProcessTimeoutSeconds(config: MxcConfig, baseline: SandboxBaselinePolicy): number {
  if (config.timeoutSecondsConfigured === true) {
    return Math.min(config.timeoutSeconds, baseline.process.timeoutSeconds);
  }
  return baseline.process.timeoutSeconds;
}

function dedupeStable(values: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

// Windows ProcessContainer normally applies filesystem policy through
// BaseContainer, but wxc-exec can fall back to host DACL mutation. Filter
// entries that cannot exist on the host before the fallback path runs:
// - Non-existent paths fail the fallback with os error 2.
// - Existing directories are valid deny targets and must not be probed with
//   openSync(), which rejects directories on Windows before MXC can enforce
//   the deny policy.
function filterMissingWindowsProcessFilesystemEntries(
  filesystem: MxcContainerConfig["filesystem"],
): MxcContainerConfig["filesystem"] {
  const keepExisting = (values: readonly string[] | undefined): string[] | undefined => {
    if (!values) {
      return values;
    }
    return values.filter((value) => existsSync(value));
  };
  const keepDeniable = (values: readonly string[] | undefined): string[] | undefined => {
    if (!values) {
      return values;
    }
    return values.filter((value) => {
      if (!existsSync(value)) {
        return false;
      }
      try {
        const stat = statSync(value);
        if (stat.isDirectory()) {
          return true;
        }
        const fd = openSync(value, "r");
        closeSync(fd);
        return true;
      } catch {
        return false;
      }
    });
  };
  return {
    ...filesystem,
    readwritePaths: keepExisting(filesystem.readwritePaths),
    readonlyPaths: keepExisting(filesystem.readonlyPaths),
    deniedPaths: keepDeniable(filesystem.deniedPaths),
  };
}

function buildContainerConfig(params: {
  config: MxcConfig;
  baseline: SandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  runtimeId: string;
  command: string;
  args?: readonly string[];
  sandboxTempDir: string;
  workdir: string;
  workspace: MxcWorkspaceContext;
  workspaceAccess: MxcWorkspaceAccess;
  env: Record<string, string>;
}): MxcContainerConfig {
  const {
    config,
    baseline,
    baselineContext,
    runtimeId,
    command,
    args,
    sandboxTempDir,
    workdir,
    workspace,
    workspaceAccess,
    env,
  } = params;
  const networkAllowed = config.network === "default";

  const readwritePaths = workspaceAccess === "rw" ? [path.resolve(workdir)] : [];
  const readonlyPaths = workspaceAccess !== "rw" ? [path.resolve(workdir)] : [];

  // Do NOT prepend `cd /d <workdir>`: inside the AppContainer spawned by
  // BaseContainer, cmd.exe runs under a restricted token that cannot access
  // per-user paths. MXC instead launches the child in `process.cwd` (see
  // resolveProcessCwd), granting the AppContainer SID access at spawn time.
  const commandScript = command;

  // MXC's BaseContainerRunner treats a non-empty process.env as a replacement
  // environment block for CreateProcessInSandbox. Include only the minimal OS
  // defaults needed by cmd/CreateProcess plus caller overrides so explicit env
  // vars work without leaking the full host environment.
  const processEnv = normalizeWindowsProcessEnvRecord({
    ...env,
    TEMP: sandboxTempDir,
    TMP: sandboxTempDir,
  });

  const mxcConfig: MxcContainerConfig = {
    version: MXC_SCHEMA_VERSION,
    containerId: uniqueContainerId(runtimeId),
    containment: config.containment,
    lifecycle: { destroyOnExit: true },
    process: {
      commandLine: buildCommandLine(commandScript, args ?? []),
      cwd: resolveProcessCwd(workdir),
      env: processEnv,
      timeout: resolveProcessTimeoutSeconds(config, baseline) * 1000,
    },
    filesystem: {
      readwritePaths,
      readonlyPaths,
    },
    ui: {
      disable: true,
      clipboard: "none",
      injection: false,
    },
    network: {
      defaultPolicy: networkAllowed ? "allow" : "block",
    },
    processContainer: {
      name: processContainerName(runtimeId),
      leastPrivilege: true,
      capabilities: networkAllowed ? ["internetClient"] : [],
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    },
  };

  const merged = applySandboxBaselineToConfig(mxcConfig, baseline, baselineContext, {
    sandboxTempDir,
    workspace,
  });
  normalizeNetworkPolicyForContainment(merged);
  merged.filesystem = filterMissingWindowsProcessFilesystemEntries(merged.filesystem);
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths: merged.filesystem.readwritePaths ?? [],
    readonlyPaths: merged.filesystem.readonlyPaths ?? [],
  });
  return merged;
}

function buildMxcLauncherOptions(config: MxcConfig, usePty: boolean): MxcLauncherOptions {
  const options: MxcLauncherOptions = {
    debug: config.debug ?? false,
    executablePath: resolveMxcBinaryPath(config.mxcBinaryPath),
  };
  if (!usePty) {
    options.usePty = false;
  }
  return options;
}

function createMxcLauncherPayload(
  config: MxcConfig,
  payload: MxcContainerConfig,
  usePty: boolean,
  sandboxTempDir: string,
): MxcExecFinalizeToken & { payloadFile: string } {
  const token = createLauncherPayloadFile(
    JSON.stringify({
      config: payload,
      options: buildMxcLauncherOptions(config, usePty),
    }),
  );
  token.sandboxTempDir = sandboxTempDir;
  return token;
}

function buildMxcLauncherArgv(payloadFile: string): string[] {
  return [process.execPath, resolveMxcLauncherPath(), "--payload-file", payloadFile];
}

/**
 * Creates a SandboxBackendHandle for a specific session.
 */
export function createMxcSandboxBackendHandle(params: {
  config: MxcConfig;
  runtimeId: string;
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: MxcWorkspaceAccess;
}): SandboxBackendHandle {
  const baselineContext = resolveCurrentBaselineContext(path.resolve(params.workdir));
  const baseline = loadSandboxBaselinePolicy({ policyPaths: params.config.mxcPolicyPaths });

  return {
    id: "mxc",
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    workdir: params.workdir,
    capabilities: {},

    async buildExecSpec({ command, workdir, env, usePty }): Promise<SandboxBackendExecSpec> {
      const effectiveWorkdir = resolveWorkdirInsideWorkspace(
        params.workdir,
        workdir ?? params.workdir,
      );
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      const workspaceAccess = params.workspaceAccess ?? "rw";
      const workspace = resolveMxcWorkspaceContext({ ...params, workspaceAccess });
      try {
        const payload = buildContainerConfig({
          config: params.config,
          baseline,
          baselineContext,
          runtimeId: params.runtimeId,
          command,
          sandboxTempDir,
          workdir: effectiveWorkdir,
          workspace,
          workspaceAccess,
          env,
        });

        // Spawn via a plugin-side Node launcher that calls
        // `@microsoft/mxc-sdk`'s `spawnSandboxFromConfig` directly. The SDK
        // owns the PTY allocation, so the launcher process appears as a plain
        // child to the host runtime. AppContainer on Windows needs ConPTY for
        // stdio inheritance; routing through the launcher keeps that detail
        // inside the plugin instead of forcing the host to promote argv into
        // a shell-quoted PTY command line.
        const payloadFile = createMxcLauncherPayload(
          params.config,
          payload,
          usePty,
          sandboxTempDir,
        );

        return {
          argv: buildMxcLauncherArgv(payloadFile.payloadFile),
          env: buildLauncherEnv(),
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
          finalizeToken: payloadFile satisfies MxcExecFinalizeToken,
        };
      } catch (err) {
        rmSync(sandboxTempDir, { force: true, recursive: true });
        throw err;
      }
    },

    async finalizeExec({ token }) {
      cleanupLauncherPayloadFile(token);
    },

    createFsBridge: ({ sandbox }) => createMxcFsBridge({ sandbox }),

    async runShellCommand(
      cmdParams: SandboxBackendCommandParams,
    ): Promise<SandboxBackendCommandResult> {
      // Shell commands use a restrictive policy (no network, 30s timeout)
      const restrictiveConfig: MxcConfig = {
        ...params.config,
        network: "none",
        timeoutSeconds: 30,
        timeoutSecondsConfigured: true,
      };
      const effectiveWorkdir = path.resolve(params.workdir);
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      const commandBridge = createWindowsCommandBridge({
        args: cmdParams.args,
        script: cmdParams.script,
        tempDir: sandboxTempDir,
      });
      const execInput = cmdParams.stdin === undefined ? Buffer.alloc(0) : toBuffer(cmdParams.stdin);
      const workspaceAccess = params.workspaceAccess ?? "rw";
      const workspace = resolveMxcWorkspaceContext({ ...params, workspaceAccess });

      try {
        const payload = buildContainerConfig({
          config: restrictiveConfig,
          baseline,
          baselineContext,
          runtimeId: params.runtimeId,
          command: commandBridge.command,
          args: cmdParams.args,
          sandboxTempDir,
          workdir: effectiveWorkdir,
          workspace,
          workspaceAccess,
          env: {},
        });

        const payloadFile = createMxcLauncherPayload(
          restrictiveConfig,
          payload,
          false,
          sandboxTempDir,
        );
        const argv = buildMxcLauncherArgv(payloadFile.payloadFile);
        const [binaryPath, ...args] = argv;
        try {
          return await execFileBuffered(binaryPath, args, {
            env: buildLauncherEnv(),
            input: execInput,
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            signal: cmdParams.signal,
          });
        } catch (err: unknown) {
          if (isAbortError(err)) {
            throw err;
          }
          const execErr = err as {
            stdout?: Buffer | string;
            stderr?: Buffer | string;
            status?: number;
            code?: number;
          };
          if (cmdParams.allowFailure) {
            return {
              stdout: toOptionalBuffer(execErr.stdout),
              stderr: toOptionalBuffer(execErr.stderr),
              code: execErr.status ?? execErr.code ?? 1,
            };
          }
          throw err;
        } finally {
          cleanupLauncherPayloadFile(payloadFile);
        }
      } finally {
        commandBridge.cleanup();
        rmSync(sandboxTempDir, { force: true, recursive: true });
      }
    },
  };
}

function execFileBuffered(
  binaryPath: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    input: Buffer;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
): Promise<SandboxBackendCommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binaryPath,
      [...args],
      {
        encoding: "buffer",
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = toOptionalBuffer(stdout);
        const stderrBuffer = toOptionalBuffer(stderr);
        if (error) {
          const errorStatus = (error as { status?: unknown }).status;
          const status =
            typeof error.code === "number"
              ? error.code
              : typeof errorStatus === "number"
                ? errorStatus
                : 1;
          const rejection: Error = Object.assign(error, {
            stdout: stdoutBuffer,
            stderr: stderrBuffer,
            status,
          });
          reject(rejection);
          return;
        }
        resolve({ stdout: stdoutBuffer, stderr: stderrBuffer, code: 0 });
      },
    );
    child.stdin?.end(options.input);
  });
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      ("code" in err && (err as { code?: unknown }).code === "ABORT_ERR"))
  );
}

function toOptionalBuffer(value: Buffer | string | undefined): Buffer {
  if (value === undefined) {
    return Buffer.alloc(0);
  }
  return toBuffer(value);
}

function toBuffer(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  return Buffer.from(value, "utf-8");
}

/** Factory function called by OpenClaw when sandbox.backend=mxc. */
export function createMxcSandboxBackendFactory(config: MxcConfig) {
  return async function createMxcSandboxBackend(
    params: CreateSandboxBackendParams,
  ): Promise<SandboxBackendHandle> {
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error("MXC sandbox backend does not support sandbox.docker.binds.");
    }
    const runtimeId = sanitizeRuntimeId(params.scopeKey);
    return createMxcSandboxBackendHandle({
      config,
      runtimeId,
      workdir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
      workspaceAccess: params.cfg.workspaceAccess,
    });
  };
}

/** Manager for `openclaw sandbox list` and `openclaw sandbox remove`. */
export const mxcSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime() {
    return {
      running: false,
      actualConfigLabel: "mxc-process",
      configLabelMatch: true,
    };
  },
  async removeRuntime() {
    // MXC containers are ephemeral and destroyed on exit automatically.
  },
};
