import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside, resolvePathPrefixSync } from "openclaw/plugin-sdk/file-access-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import type {
  SandboxBackendHandle,
  SandboxBackendExecSpec,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { buildMxcNativeEnv, resolveMxcNativeBinaries } from "./binary-resolver.js";
import type { MxcConfig } from "./config.js";
import { createMxcFsBridge } from "./fs-bridge.js";
import {
  buildMxcContainerRequest,
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

type MxcExecFinalizeToken = {
  payloadDir: string;
  sandboxTempDir?: string;
};

// MXC uses containerName as the 64-character-limited AppContainer profile name.
// Keep runtimeId stable for bookkeeping; mint a per-call ID to avoid collisions.
const CONTAINER_NAME_MAX_LEN = 64;
function uniqueContainerName(runtimeId: string): string {
  const suffix = randomBytes(4).toString("hex");
  const base =
    runtimeId.length + suffix.length + 1 > CONTAINER_NAME_MAX_LEN
      ? runtimeId.slice(0, CONTAINER_NAME_MAX_LEN - suffix.length - 1)
      : runtimeId;
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

// ENOTDIR means a parent component is a file, so the path can never resolve to a
// directory. Classifying it alongside ENOENT keeps validateWorkdir's "return null
// for unusable workdirs" contract intact instead of leaking a raw filesystem error.
function isMissingPathError(err: unknown): boolean {
  const code = extractErrorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

// Resolved per call so a missing or replaced native tree fails the launch that
// would have used it, instead of the SDK silently selecting packaged binaries.
function resolveLauncherNativeEnv(config: MxcConfig): Record<string, string> {
  return buildMxcNativeEnv(resolveMxcNativeBinaries(config.mxcBinaryPath));
}

function createMxcLauncherPayload(
  config: MxcConfig,
  request: ContainerRequest,
  usePty: boolean,
  sandboxTempDir: string,
): MxcExecFinalizeToken & { payloadFile: string } {
  const payloadJson = JSON.stringify({
    request,
    options: {
      debug: config.debug,
      pty: usePty,
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
  workspaceAccess?: MxcWorkspaceAccess;
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
      const baselineContext = resolveCurrentBaselineContext(workspace.activeWorkspaceDir);
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      try {
        const launcherEnv = buildLauncherEnv(resolveLauncherNativeEnv(params.config));
        const payload = buildMxcContainerRequest({
          config: params.config,
          baseline,
          baselineContext,
          containerName: uniqueContainerName(params.runtimeId),
          command,
          sandboxTempDir,
          workdir: runtimeWorkdir,
          workspace,
          env,
        });

        // Spawn via a plugin-side Node launcher that calls the SDK's v1
        // `spawn`/`spawnWithPty` directly. The SDK owns the PTY allocation, so
        // the launcher process appears as a plain child to the host runtime.
        // Routing through the launcher keeps ConPTY and the native-library
        // pinning inside the plugin instead of forcing the host to promote argv
        // into a shell-quoted PTY command line.
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
          env: launcherEnv,
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
      const workspace = resolveMxcWorkspaceContext(params);
      const runtimeWorkdir = resolveMxcRuntimeWorkdir(workspace, effectiveWorkdir);
      const baselineContext = resolveCurrentBaselineContext(workspace.activeWorkspaceDir);
      const sandboxTempDir = createSandboxTempDir(baselineContext.hostEnv);
      let commandBridge: ReturnType<typeof createWindowsCommandBridge> | undefined;

      try {
        const launcherEnv = buildLauncherEnv(resolveLauncherNativeEnv(restrictiveConfig));
        commandBridge = createWindowsCommandBridge({
          args: cmdParams.args,
          script: cmdParams.script,
          tempDir: sandboxTempDir,
        });
        const execInput = Buffer.isBuffer(cmdParams.stdin)
          ? cmdParams.stdin
          : Buffer.from(cmdParams.stdin ?? "", "utf-8");
        const payload = buildMxcContainerRequest({
          config: restrictiveConfig,
          baseline,
          baselineContext,
          containerName: uniqueContainerName(params.runtimeId),
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
            baseEnv: launcherEnv,
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
