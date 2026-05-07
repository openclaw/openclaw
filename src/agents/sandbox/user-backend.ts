import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import { buildExecRemoteCommand, buildRemoteCommand } from "./ssh.js";
import {
  buildUserSandboxArgv,
  resolveUserSandboxHome,
  runUserSandboxCommand,
  uploadDirectoryToUserTarget,
  type UserSandboxSettings,
} from "./user.js";

type ResolvedUserRuntimePaths = {
  runtimeId: string;
  runtimeRootDir: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
};

export const userSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const cfg = resolveSandboxConfigForAgent(config, agentId);
    if (cfg.backend !== "user" || !cfg.user.username) {
      return {
        running: false,
        actualConfigLabel: cfg.user.username,
        configLabelMatch: false,
      };
    }
    const settings = resolveUserSandboxSettings(cfg.user);
    const homeDir = await resolveUserSandboxHome(settings);
    const runtimePaths = resolveUserRuntimePaths({
      config: cfg.user,
      homeDir,
      scopeKey: entry.sessionKey,
      workspaceAccess: cfg.workspaceAccess,
    });
    const result = await runUserSandboxCommand({
      settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
        "openclaw-user-check",
        runtimePaths.runtimeRootDir,
      ]),
    });
    return {
      running: result.stdout.toString("utf8").trim() === "1",
      actualConfigLabel: cfg.user.username,
      configLabelMatch: entry.image === cfg.user.username,
    };
  },
  async removeRuntime({ entry, config, agentId }) {
    const cfg = resolveSandboxConfigForAgent(config, agentId);
    if (cfg.backend !== "user" || !cfg.user.username) {
      return;
    }
    const settings = resolveUserSandboxSettings(cfg.user);
    const homeDir = await resolveUserSandboxHome(settings);
    const runtimePaths = resolveUserRuntimePaths({
      config: cfg.user,
      homeDir,
      scopeKey: entry.sessionKey,
      workspaceAccess: cfg.workspaceAccess,
    });
    await runUserSandboxCommand({
      settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'rm -rf -- "$1"',
        "openclaw-user-remove",
        runtimePaths.runtimeRootDir,
      ]),
      allowFailure: true,
    });
  },
};

export async function createUserSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  if ((params.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("User sandbox backend does not support sandbox.docker.binds.");
  }
  const settings = resolveUserSandboxSettings(params.cfg.user);
  const homeDir = await resolveUserSandboxHome(settings);
  const runtimePaths = resolveUserRuntimePaths({
    config: params.cfg.user,
    homeDir,
    scopeKey: params.scopeKey,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const impl = new UserSandboxBackendImpl({
    createParams: params,
    settings,
    runtimePaths,
  });
  return impl.asHandle();
}

class UserSandboxBackendImpl {
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      settings: UserSandboxSettings;
      runtimePaths: ResolvedUserRuntimePaths;
    },
  ) {}

  asHandle(): SandboxBackendHandle & RemoteShellSandboxHandle {
    return {
      id: "user",
      runtimeId: this.params.runtimePaths.runtimeId,
      runtimeLabel: this.params.runtimePaths.runtimeId,
      workdir: this.params.runtimePaths.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.settings.username,
      configLabelKind: "User",
      remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env }) => {
        await this.ensureRuntime();
        const remoteCommand = buildExecRemoteCommand({
          command,
          workdir: workdir ?? this.params.runtimePaths.remoteWorkspaceDir,
          env,
        });
        return {
          argv: buildUserSandboxArgv({
            settings: this.params.settings,
            remoteCommand,
          }),
          env: sanitizeEnvVars(process.env).allowed,
          stdinMode: "pipe-open",
        };
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    const exists = await runUserSandboxCommand({
      settings: this.params.settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
        "openclaw-user-check",
        this.params.runtimePaths.runtimeRootDir,
      ]),
    });
    if (exists.stdout.toString("utf8").trim() === "1") {
      return;
    }
    await runUserSandboxCommand({
      settings: this.params.settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'mkdir -p -- "$1"',
        "openclaw-user-runtime",
        this.params.runtimePaths.runtimeRootDir,
      ]),
    });
    await this.replaceTargetDirectoryFromLocal(
      this.params.createParams.workspaceDir,
      this.params.runtimePaths.remoteWorkspaceDir,
    );
    if (
      this.params.createParams.cfg.workspaceAccess !== "none" &&
      path.resolve(this.params.createParams.agentWorkspaceDir) !==
        path.resolve(this.params.createParams.workspaceDir)
    ) {
      await this.replaceTargetDirectoryFromLocal(
        this.params.createParams.agentWorkspaceDir,
        this.params.runtimePaths.remoteAgentWorkspaceDir,
      );
    }
  }

  private async replaceTargetDirectoryFromLocal(
    localDir: string,
    targetDir: string,
  ): Promise<void> {
    await runUserSandboxCommand({
      settings: this.params.settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        "openclaw-user-clear",
        targetDir,
      ]),
    });
    await uploadDirectoryToUserTarget({
      settings: this.params.settings,
      localDir,
      targetDir,
    });
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    return await runUserSandboxCommand({
      settings: this.params.settings,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        params.script,
        "openclaw-user-fs",
        ...(params.args ?? []),
      ]),
      stdin: params.stdin,
      allowFailure: params.allowFailure,
      signal: params.signal,
    });
  }
}

function resolveUserSandboxSettings(config: {
  command: string;
  username?: string;
}): UserSandboxSettings {
  const username = config.username?.trim();
  if (!username) {
    throw new Error('Sandbox backend "user" requires agents.defaults.sandbox.user.username.');
  }
  if (username.startsWith("-")) {
    throw new Error("Sandbox user username must not start with '-'.");
  }
  return {
    command: config.command.trim() || "su",
    username,
  };
}

function resolveUserRuntimePaths(params: {
  config: {
    workspaceDir?: string;
    workspaceRoot?: string;
  };
  homeDir: string;
  scopeKey: string;
  workspaceAccess: "none" | "ro" | "rw";
}): ResolvedUserRuntimePaths {
  const homeDir = normalizeAbsoluteUserPath(params.homeDir, "/", "sandbox user home");
  const remoteAgentWorkspaceDir = normalizeAbsoluteUserPath(
    params.config.workspaceDir,
    path.posix.join(homeDir, ".openclaw", "workspace"),
    "Sandbox user workspaceDir",
    homeDir,
  );
  const workspaceRoot = normalizeAbsoluteUserPath(
    params.config.workspaceRoot,
    path.posix.join(homeDir, ".openclaw", "sandboxes"),
    "Sandbox user workspaceRoot",
    homeDir,
  );
  const runtimeId = buildUserSandboxRuntimeId(params.scopeKey);
  const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
  return {
    runtimeId,
    runtimeRootDir,
    remoteWorkspaceDir:
      params.workspaceAccess === "rw"
        ? remoteAgentWorkspaceDir
        : path.posix.join(runtimeRootDir, "workspace"),
    remoteAgentWorkspaceDir,
  };
}

function normalizeAbsoluteUserPath(
  value: string | undefined,
  fallback: string,
  label: string,
  homeDir?: string,
): string {
  const raw = (value?.trim() || fallback).replaceAll("\\", "/");
  const expanded =
    raw === "~"
      ? (homeDir ?? fallback)
      : raw.startsWith("~/") && homeDir
        ? path.posix.join(homeDir, raw.slice(2))
        : raw;
  if (!path.posix.isAbsolute(expanded)) {
    throw new Error(`${label} must be an absolute POSIX path: ${raw}`);
  }
  return expanded.replace(/\/+$/g, "") || "/";
}

function buildUserSandboxRuntimeId(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-user-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
