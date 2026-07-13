import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import type {
  SandboxBackendHandle,
  SandboxBackendExecSpec,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { resolveMxcBinaryPath } from "./binary-resolver.js";
import type { MxcConfig } from "./config.js";
import { createMxcFsBridge } from "./fs-bridge.js";
import {
  buildMxcContainerConfig,
  resolveCurrentBaselineContext,
  resolveMxcRuntimeWorkdir,
  resolveMxcWorkspaceContext,
} from "./mxc-container-config.js";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import { resolveSandboxTempDir, type BaselineHostEnv } from "./sandbox-baseline.js";
import { loadSandboxBaselinePolicy } from "./sandbox-policy-loader.js";
import { createWindowsCommandBridge } from "./windows-command.js";
import { buildLauncherEnv } from "./windows-env.js";
import type { MxcWorkspaceAccess } from "./workspace-skill-mounts.js";

type MxcLauncherOptions = {
  debug: boolean;
  executablePath?: string;
  usePty?: boolean;
};

type MxcExecFinalizeToken = {
  payloadDir: string;
  sandboxTempDir?: string;
};

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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
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
  payload: ContainerConfig,
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

function buildMxcLauncherArgv(payloadFile: string): [string, string, string, string] {
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
      const workspaceAccess = params.workspaceAccess ?? "rw";
      const workspace = resolveMxcWorkspaceContext({ ...params, workspaceAccess });
      const runtimeWorkdir = resolveMxcRuntimeWorkdir(workspace, effectiveWorkdir);
      const baselineContext = resolveCurrentBaselineContext(workspace.activeWorkspaceDir);
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      try {
        const payload = buildMxcContainerConfig({
          config: params.config,
          baseline,
          baselineContext,
          runtimeId: params.runtimeId,
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
      const workspaceAccess = params.workspaceAccess ?? "rw";
      const workspace = resolveMxcWorkspaceContext({ ...params, workspaceAccess });
      const runtimeWorkdir = resolveMxcRuntimeWorkdir(workspace, effectiveWorkdir);
      const baselineContext = resolveCurrentBaselineContext(workspace.activeWorkspaceDir);
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      const commandBridge = createWindowsCommandBridge({
        args: cmdParams.args,
        script: cmdParams.script,
        tempDir: sandboxTempDir,
      });
      const execInput = cmdParams.stdin === undefined ? Buffer.alloc(0) : toBuffer(cmdParams.stdin);

      try {
        const payload = buildMxcContainerConfig({
          config: restrictiveConfig,
          baseline,
          baselineContext,
          runtimeId: params.runtimeId,
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
