import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import { isPathInside, resolvePathPrefixSync } from "openclaw/plugin-sdk/file-access-runtime";
import { isNotFoundPathError as isMissingPathError } from "openclaw/plugin-sdk/path-existence-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  type SandboxBackendHandle,
  type SandboxBackendExecSpec,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
  type SandboxBackendManager,
  type SandboxContext,
  resolveReadOnlyWorkspaceSkillMounts,
} from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import type { MxcConfig } from "./config.js";
import { MxcFsBridge } from "./fs-bridge.js";
import { normalizeMxcPathForComparison } from "./path-comparison.js";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import {
  resolveSandboxTempDir,
  type BaselineHostEnv,
  resolveBaselineReadonlyPaths,
} from "./sandbox-baseline.js";
import {
  loadSandboxBaselinePolicy,
  type LoadedSandboxBaselinePolicy,
  type SandboxConfiguredPathEntry,
} from "./sandbox-policy-loader.js";
import { createWindowsCommandBridge, buildCommandLine } from "./windows-command.js";
import { buildLauncherEnv, normalizeWindowsProcessEnvRecord } from "./windows-env.js";

const MXC_SCHEMA_VERSION = "0.7.0-alpha";

type FilesystemPathSpec = {
  path: string;
  required: boolean;
  sources?: readonly string[];
};

type BaselineApplicationContext = {
  hostEnv: BaselineHostEnv;
};

type MxcWorkspaceContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  activeWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxContext["workspaceAccess"];
};

function resolveCurrentBaselineContext(): BaselineApplicationContext {
  return {
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

function resolveMxcWorkspaceContext(params: {
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: SandboxContext["workspaceAccess"];
}): MxcWorkspaceContext {
  const workspaceAccess = params.workspaceAccess ?? "rw";
  const workspaceDir = path.resolve(params.workdir);
  const agentWorkspaceDir = path.resolve(params.agentWorkspaceDir ?? params.workdir);
  return {
    workspaceDir,
    agentWorkspaceDir,
    activeWorkspaceDir: workspaceAccess === "rw" ? agentWorkspaceDir : workspaceDir,
    ...(params.skillsWorkspaceDir
      ? { skillsWorkspaceDir: path.resolve(params.skillsWorkspaceDir) }
      : {}),
    workdir: workspaceDir,
    workspaceAccess,
  };
}

function resolveMxcRuntimeWorkdir(
  workspace: MxcWorkspaceContext,
  requestedWorkdir: string,
): string {
  if (workspace.workspaceAccess !== "rw") {
    return path.resolve(requestedWorkdir);
  }

  const relativePath = path.relative(workspace.workspaceDir, requestedWorkdir);
  return relativePath === ""
    ? workspace.activeWorkspaceDir
    : path.join(workspace.activeWorkspaceDir, relativePath);
}

function buildMxcContainerConfig(params: {
  config: MxcConfig;
  baseline: LoadedSandboxBaselinePolicy;
  baselineContext: BaselineApplicationContext;
  containerId: string;
  command: string;
  args?: readonly string[];
  sandboxTempDir: string;
  workdir: string;
  workspace: MxcWorkspaceContext;
  env: Record<string, string>;
}): ContainerConfig {
  const networkAllowed = params.config.network === "default";
  const readwritePathSpecs: FilesystemPathSpec[] = [];
  const readonlyPathSpecs: FilesystemPathSpec[] = [];
  const workspace = params.workspace;
  const protectedSkillPolicyPaths = resolveMxcProtectedSkillPolicyPaths(workspace);
  if (workspace.workspaceAccess === "rw") {
    readwritePathSpecs.push(requiredFilesystemPath(workspace.activeWorkspaceDir));
  } else {
    readonlyPathSpecs.push(requiredFilesystemPath(workspace.workspaceDir));
    if (
      workspace.workspaceAccess === "ro" &&
      normalizeMxcPathForComparison(workspace.agentWorkspaceDir) !==
        normalizeMxcPathForComparison(workspace.workspaceDir)
    ) {
      readonlyPathSpecs.push(requiredFilesystemPath(workspace.agentWorkspaceDir));
    }
  }
  readonlyPathSpecs.push(
    ...resolveBaselineReadonlyPaths(params.baselineContext.hostEnv).map(optionalFilesystemPath),
    ...params.baseline.configuredPaths.readonlyPaths.map(createConfiguredFilesystemPath),
    ...protectedSkillPolicyPaths.map(optionalFilesystemPath),
  );

  readwritePathSpecs.push(requiredFilesystemPath(params.sandboxTempDir));
  readwritePathSpecs.push(
    ...params.baseline.configuredPaths.readwritePaths.map(createConfiguredFilesystemPath),
  );

  const readwritePaths = resolveExistingFilesystemPaths(readwritePathSpecs, "readwrite");
  // ProcessContainer writable-parent grants override nested read-only grants.
  // Fail closed instead of claiming protected skill overlays are enforceable.
  assertNoMxcReadwriteReadonlyOverlap({
    readwritePaths,
    readonlyPaths: protectedSkillPolicyPaths,
  });

  const readonlyPaths = resolveExistingFilesystemPaths(readonlyPathSpecs, "read-only");
  assertNoMxcReadwriteReadonlyOverlap({ readwritePaths, readonlyPaths });

  const filesystem = {
    readonlyPaths,
    deniedPaths: undefined,
    readwritePaths,
  };
  const processEnv = normalizeWindowsProcessEnvRecord({
    ...params.env,
    TEMP: params.sandboxTempDir,
    TMP: params.sandboxTempDir,
  });

  return {
    version: MXC_SCHEMA_VERSION,
    containerId: params.containerId,
    containment: params.config.containment,
    // The raw config goes straight to wxc-exec, which only understands the wire
    // `lifecycle.preservePolicy`; the SDK's `filesystem.clearPolicyOnExit` alias is
    // mapped only by `createConfigFromPolicy`.
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: {
      commandLine: buildCommandLine(params.command, params.args ?? []),
      cwd: params.workdir,
      env: processEnv,
      timeout:
        (params.config.timeoutSecondsConfigured === true
          ? Math.min(params.config.timeoutSeconds, params.baseline.process.timeoutSeconds)
          : params.baseline.process.timeoutSeconds) * 1000,
    },
    filesystem,
    ui: {
      disable: true,
      clipboard: "none",
      injection: false,
    },
    network: {
      defaultPolicy: networkAllowed ? "allow" : "block",
      enforcementMode: "capabilities",
    },
    processContainer: {
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
}

function resolveMxcProtectedSkillPolicyPaths(context: MxcWorkspaceContext): string[] {
  if (context.workspaceAccess !== "rw") {
    return [];
  }
  const deduped = new Map<string, string>();
  for (const mount of resolveReadOnlyWorkspaceSkillMounts(context)) {
    const hostPath = path.resolve(mount.hostPath);
    deduped.set(normalizeMxcPathForComparison(hostPath), hostPath);
    const containerPath = path.resolve(mount.containerPath);
    deduped.set(normalizeMxcPathForComparison(containerPath), containerPath);
  }
  return [...deduped.values()];
}

function resolveExistingFilesystemPaths(
  pathSpecs: readonly FilesystemPathSpec[],
  accessLabel: "read-only" | "readwrite",
): string[] {
  const deduped = new Map<
    string,
    {
      path: string;
      required: boolean;
      sources: Set<string>;
    }
  >();

  for (const pathSpec of pathSpecs) {
    const key = normalizeMxcPathForComparison(pathSpec.path);
    const existing = deduped.get(key);
    if (existing) {
      existing.required ||= pathSpec.required;
      for (const source of pathSpec.sources ?? []) {
        existing.sources.add(source);
      }
      continue;
    }

    deduped.set(key, {
      path: pathSpec.path,
      required: pathSpec.required,
      sources: new Set(pathSpec.sources ?? []),
    });
  }

  const resolvedPaths: string[] = [];
  for (const pathSpec of deduped.values()) {
    if (hostPathExists(pathSpec.path)) {
      resolvedPaths.push(pathSpec.path);
      continue;
    }
    if (!pathSpec.required) {
      continue;
    }
    throw new Error(
      buildMissingFilesystemPathMessage(pathSpec.path, accessLabel, pathSpec.sources),
    );
  }
  return resolvedPaths;
}

function requiredFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: true,
  };
}

function optionalFilesystemPath(pathValue: string): FilesystemPathSpec {
  return {
    path: path.resolve(pathValue),
    required: false,
  };
}

function createConfiguredFilesystemPath(pathEntry: SandboxConfiguredPathEntry): FilesystemPathSpec {
  return {
    path: path.resolve(pathEntry.path),
    required: true,
    sources: pathEntry.sources,
  };
}

function buildMissingFilesystemPathMessage(
  pathValue: string,
  accessLabel: "read-only" | "readwrite",
  sources: ReadonlySet<string>,
): string {
  const sourceLabel = [...sources].join(", ");
  if (sourceLabel) {
    return (
      `MXC sandbox ${accessLabel} path ${pathValue} configured by ${sourceLabel} ` +
      `is missing on the host. Recreate the path or update the policy file before launching the sandbox.`
    );
  }
  return `MXC sandbox ${accessLabel} path ${pathValue} does not exist on the host.`;
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
  const left = normalizeMxcPathForComparison(first);
  const right = normalizeMxcPathForComparison(second);
  return isPathInside(left, right) || isPathInside(right, left);
}

function hostPathExists(candidatePath: string): boolean {
  try {
    statSync(candidatePath);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      return false;
    }
    throw err;
  }
}

type MxcExecFinalizeToken = {
  payloadDir: string;
  sandboxTempDir?: string;
};

// MXC uses containerId as the 64-character-limited AppContainer profile name.
// Keep runtimeId stable for bookkeeping; mint a per-call ID to avoid collisions.
const CONTAINER_ID_MAX_LEN = 64;
function uniqueContainerId(runtimeId: string): string {
  const suffix = randomBytes(4).toString("hex");
  const base = runtimeId.slice(0, CONTAINER_ID_MAX_LEN - suffix.length - 1);
  return `${base}-${suffix}`;
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

function resolveWorkdirInsideWorkspace(workspaceDir: string, workdir: string): string {
  const workspace = realpathForExistingPath(workspaceDir, "sandbox workspace");
  try {
    const { existingPath, unresolvedSegments } = resolvePathPrefixSync(workdir);
    const candidate = path.join(existingPath, ...unresolvedSegments);
    if (!isPathInside(workspace, candidate)) {
      throw new Error(
        `MXC sandbox workdir ${workdir} is outside the sandbox workspace ${workspaceDir}. ` +
          `Use a workdir inside the sandbox workspace.`,
      );
    }
    if (statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch (err) {
    if (isMissingPathError(err)) {
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
    if (isMissingPathError(err)) {
      throw new Error(`MXC ${label} ${value} does not exist.`, { cause: err });
    }
    throw err;
  }
}

function createMxcLauncherPayload(
  config: MxcConfig,
  payload: ContainerConfig,
  usePty: boolean,
  sandboxTempDir: string,
): MxcExecFinalizeToken & { payloadFile: string } {
  const payloadJson = JSON.stringify({
    config: payload,
    options: {
      debug: config.debug,
      executablePath: resolveMxcBinaryPath(config.mxcBinaryPath),
      ...(!usePty ? { usePty: false } : {}),
    },
  });
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
  return { payloadDir, payloadFile, sandboxTempDir };
}

export function createMxcSandboxBackendHandle(params: {
  config: MxcConfig;
  runtimeId: string;
  workdir: string;
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: SandboxContext["workspaceAccess"];
}): SandboxBackendHandle {
  const baseline = loadSandboxBaselinePolicy({ policyPaths: params.config.mxcPolicyPaths });

  return {
    id: "mxc",
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    workdir: params.workdir,
    workdirValidation: "backend",
    async validateWorkdir(workdir) {
      try {
        return resolveWorkdirInsideWorkspace(params.workdir, workdir);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("MXC sandbox workdir")) {
          return null;
        }
        throw err;
      }
    },
    capabilities: {},

    async buildExecSpec({ command, workdir, env, usePty }): Promise<SandboxBackendExecSpec> {
      const effectiveWorkdir = resolveWorkdirInsideWorkspace(
        params.workdir,
        workdir ?? params.workdir,
      );
      const workspace = resolveMxcWorkspaceContext(params);
      const runtimeWorkdir = resolveMxcRuntimeWorkdir(workspace, effectiveWorkdir);
      const baselineContext = resolveCurrentBaselineContext();
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      try {
        const payload = buildMxcContainerConfig({
          config: params.config,
          baseline,
          baselineContext,
          containerId: uniqueContainerId(params.runtimeId),
          command,
          sandboxTempDir,
          workdir: runtimeWorkdir,
          workspace,
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
          argv: [
            process.execPath,
            resolveMxcLauncherPath(),
            "--payload-file",
            payloadFile.payloadFile,
          ],
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

    createFsBridge: ({ sandbox }) => new MxcFsBridge(sandbox),

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
      const workspace = resolveMxcWorkspaceContext(params);
      const runtimeWorkdir = resolveMxcRuntimeWorkdir(workspace, effectiveWorkdir);
      const baselineContext = resolveCurrentBaselineContext();
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      let commandBridge: ReturnType<typeof createWindowsCommandBridge> | undefined;

      try {
        commandBridge = createWindowsCommandBridge({
          args: cmdParams.args,
          script: cmdParams.script,
          tempDir: sandboxTempDir,
        });
        const execInput = Buffer.isBuffer(cmdParams.stdin)
          ? cmdParams.stdin
          : Buffer.from(cmdParams.stdin ?? "", "utf-8");
        const payload = buildMxcContainerConfig({
          config: restrictiveConfig,
          baseline,
          baselineContext,
          containerId: uniqueContainerId(params.runtimeId),
          command: commandBridge.command,
          args: cmdParams.args,
          sandboxTempDir,
          workdir: runtimeWorkdir,
          workspace,
          env: {},
        });

        const payloadFile = createMxcLauncherPayload(
          restrictiveConfig,
          payload,
          false,
          sandboxTempDir,
        );
        const argv = [
          process.execPath,
          resolveMxcLauncherPath(),
          "--payload-file",
          payloadFile.payloadFile,
        ];
        try {
          const result = await runCommandBuffered(argv, {
            baseEnv: buildLauncherEnv(),
            input: execInput,
            maxOutputBytes: { stdout: 10 * 1024 * 1024, stderr: 10 * 1024 * 1024 },
            signal: cmdParams.signal,
            timeoutMs: 30_000,
          });
          if (cmdParams.signal?.aborted) {
            throw cmdParams.signal.reason instanceof Error
              ? cmdParams.signal.reason
              : (result.error ?? new Error("MXC command aborted"));
          }
          const { stdout, stderr } = result;
          const code = result.termination === "exit" ? (result.code ?? 1) : 1;
          if ((result.termination !== "exit" || code !== 0) && !cmdParams.allowFailure) {
            const commandError =
              result.error ??
              new Error(
                result.termination === "exit"
                  ? `MXC command exited with code ${code}`
                  : `MXC command terminated: ${result.termination}`,
              );
            throw Object.assign(commandError, {
              stdout,
              stderr,
              status: code,
            });
          }
          return { stdout, stderr, code };
        } finally {
          cleanupLauncherPayloadFile(payloadFile);
        }
      } finally {
        commandBridge?.cleanup();
        rmSync(sandboxTempDir, { force: true, recursive: true });
      }
    },
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
