/**
 * Tenki Cloud sandbox backend implementation.
 *
 * Runs sandbox workloads in remote Tenki microVM sessions via @tenkicloud/sandbox,
 * mirrors the workspace into the session, and reuses the backend-neutral remote
 * shell filesystem bridge over the SDK exec surface.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isTerminal, TenkiSandbox, type Session } from "@tenkicloud/sandbox";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import {
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  sanitizeEnvVars,
} from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTenkiPluginConfig, type ResolvedTenkiPluginConfig } from "./config.js";
import { buildPositionalArgsPrefix } from "./shell.js";
import {
  buildSshExecArgv,
  ensureTenkiSshKeypair,
  mintSessionSshCert,
  shouldRenewSessionSshCert,
  startTenkiSshForwarder,
  waitForSshAuth,
  type TenkiSshForwarder,
  type TenkiSshKeypair,
  type TenkiSshSessionCert,
} from "./ssh-transport.js";
import { createLocalTarball } from "./upload.js";

const TENKI_SESSION_TAG = "openclaw";

// Tenki's data-plane file API only accepts paths beneath the guest workdir
// (/home/tenki); shell exec is unrestricted. Stage writeFile payloads here.
const TENKI_SESSION_WORKDIR = "/home/tenki";

// Local copies of the core SSH backend's remote shell scripts; the plugin SDK
// exports the argv-string builders but not the raw scripts, and the SDK exec
// surface needs the scripts themselves (openshell carries its own copies too).
const ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT = [
  "set -e",
  'target="$1"',
  'root="${2:-$1}"',
  'case "$target" in /*) ;; *) echo "remote directory must be absolute: $target" >&2; exit 1 ;; esac',
  'case "$root" in /*) ;; *) echo "remote root must be absolute: $root" >&2; exit 1 ;; esac',
  'target="${target%/}"',
  'root="${root%/}"',
  '[ -n "$target" ] || target="/"',
  '[ -n "$root" ] || root="/"',
  'case "$target/" in "$root"/*|"$root/") ;; *) echo "remote directory must stay under root: $target" >&2; exit 1 ;; esac',
  'for path_to_check in "$target" "$root"; do',
  '  relative="${path_to_check#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "  done",
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'mkdir -p -- "$root"',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'while [ -n "$relative" ]; do',
  '  part="${relative%%/*}"',
  '  if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '  [ -n "$part" ] || continue',
  '  if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '  if [ -L "$next" ]; then echo "unsafe remote directory symlink: $next" >&2; exit 1; fi',
  '  if [ -e "$next" ]; then',
  '    if [ ! -d "$next" ]; then echo "unsafe remote directory component: $next" >&2; exit 1; fi',
  "  else",
  '    mkdir -- "$next"',
  "  fi",
  '  current="$next"',
  "done",
].join("\n");

const VALIDATE_REMOTE_WORKDIR_SCRIPT = [
  "set -e",
  'target="$1"',
  'root="$2"',
  'case "$target" in /*) ;; *) echo "remote directory must be absolute: $target" >&2; exit 1 ;; esac',
  'case "$root" in /*) ;; *) echo "remote root must be absolute: $root" >&2; exit 1 ;; esac',
  'target="${target%/}"',
  'root="${root%/}"',
  '[ -n "$target" ] || target="/"',
  '[ -n "$root" ] || root="/"',
  'if [ "$root" != "/" ]; then',
  '  case "$target/" in "$root"/*|"$root/") ;; *) echo "remote directory must stay under root: $target" >&2; exit 1 ;; esac',
  "fi",
  'for path_to_check in "$target" "$root"; do',
  '  relative="${path_to_check#/}"',
  '  while [ -n "$relative" ]; do',
  '    part="${relative%%/*}"',
  '    if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '    [ -n "$part" ] || continue',
  '    case "$part" in "."|"..") echo "unsafe remote directory component: $part" >&2; exit 1 ;; esac',
  "  done",
  "done",
  'if [ -L "$root" ]; then echo "unsafe remote root symlink: $root" >&2; exit 1; fi',
  'if [ ! -d "$root" ]; then echo "remote root not found: $root" >&2; exit 1; fi',
  'canonical_root="$(cd "$root" && pwd -P)"',
  'relative="${target#"$root"}"',
  'relative="${relative#/}"',
  'current="$canonical_root"',
  'while [ -n "$relative" ]; do',
  '  part="${relative%%/*}"',
  '  if [ "$part" = "$relative" ]; then relative=""; else relative="${relative#*/}"; fi',
  '  [ -n "$part" ] || continue',
  '  if [ "$current" = "/" ]; then next="/$part"; else next="$current/$part"; fi',
  '  if [ -L "$next" ]; then echo "unsafe remote directory symlink: $next" >&2; exit 1; fi',
  '  if [ ! -d "$next" ]; then echo "remote directory not found: $next" >&2; exit 1; fi',
  '  current="$next"',
  "done",
  'printf "%s\\n" "$current"',
].join("\n");

type ResolvedTenkiRuntimePaths = {
  runtimeId: string;
  runtimeRootDir: string;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  remoteSkillsWorkspaceDir: string;
};

function createTenkiClient(cfg: ResolvedTenkiPluginConfig): TenkiSandbox {
  // authToken/baseUrl fall back to TENKI_AUTH_TOKEN / TENKI_API_ENDPOINT inside the SDK.
  return new TenkiSandbox({
    authToken: cfg.authToken,
    baseUrl: cfg.baseUrl,
  });
}

async function findRuntimeSessions(
  cfg: ResolvedTenkiPluginConfig,
  runtimeId: string,
): Promise<Session[]> {
  const client = createTenkiClient(cfg);
  const sessions = await client.list({ tags: [runtimeId] });
  return sessions.filter((session) => !isTerminal(session.state));
}

function tenkiConfigLabel(cfg: ResolvedTenkiPluginConfig): string {
  return cfg.image ?? "tenki-default";
}

function resolveTenkiPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedTenkiPluginConfig,
): ResolvedTenkiPluginConfig {
  const pluginConfig = config.plugins?.entries?.tenki?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveTenkiPluginConfig(pluginConfig);
}

/** Create the Tenki backend factory bound to resolved plugin config. */
export function createTenkiSandboxBackendFactory(params: {
  pluginConfig: ResolvedTenkiPluginConfig;
}): SandboxBackendFactory {
  return async (createParams) =>
    await createTenkiSandboxBackend({
      pluginConfig: params.pluginConfig,
      createParams,
    });
}

/** Tenki backend lifecycle hooks for probing and removing remote sessions. */
export function createTenkiSandboxBackendManager(params: {
  pluginConfig: ResolvedTenkiPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const cfg = resolveTenkiPluginConfigFromConfig(config, params.pluginConfig);
      const runtimePaths = resolveTenkiRuntimePaths(cfg.workspaceRoot, entry.sessionKey);
      const sessions = await findRuntimeSessions(cfg, runtimePaths.runtimeId);
      return {
        running: sessions.length > 0,
        actualConfigLabel: tenkiConfigLabel(cfg),
        configLabelMatch: entry.image === tenkiConfigLabel(cfg),
      };
    },
    async removeRuntime({ entry, config }) {
      const cfg = resolveTenkiPluginConfigFromConfig(config, params.pluginConfig);
      const runtimePaths = resolveTenkiRuntimePaths(cfg.workspaceRoot, entry.sessionKey);
      const sessions = await findRuntimeSessions(cfg, runtimePaths.runtimeId);
      for (const session of sessions) {
        await session.closeIfOpen();
      }
    },
  };
}

async function createTenkiSandboxBackend(params: {
  pluginConfig: ResolvedTenkiPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SandboxBackendHandle> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("Tenki sandbox backend does not support sandbox.docker.binds.");
  }
  const runtimePaths = resolveTenkiRuntimePaths(
    params.pluginConfig.workspaceRoot,
    params.createParams.scopeKey,
  );
  const impl = new TenkiSandboxBackendImpl({
    pluginConfig: params.pluginConfig,
    createParams: params.createParams,
    runtimePaths,
  });
  return impl.asHandle();
}

class TenkiSandboxBackendImpl {
  private sessionPromise: Promise<Session> | null = null;
  private ensurePromise: Promise<void> | null = null;
  private sshKeypairPromise: Promise<TenkiSshKeypair> | null = null;
  private sshForwarderPromise: Promise<TenkiSshForwarder> | null = null;
  private sshCert: TenkiSshSessionCert | null = null;
  private sshCertSessionId: string | null = null;

  constructor(
    private readonly params: {
      pluginConfig: ResolvedTenkiPluginConfig;
      createParams: CreateSandboxBackendParams;
      runtimePaths: ResolvedTenkiRuntimePaths;
    },
  ) {}

  private get cfg(): ResolvedTenkiPluginConfig {
    return this.params.pluginConfig;
  }

  asHandle(): SandboxBackendHandle {
    return {
      id: "tenki",
      runtimeId: this.params.runtimePaths.runtimeId,
      runtimeLabel: this.params.runtimePaths.runtimeId,
      workdir: this.params.runtimePaths.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: tenkiConfigLabel(this.cfg),
      configLabelKind: "Image",
      workdirValidation: "backend",
      validateWorkdir: async (workdir) => await this.validateWorkdir(workdir),
      workdirRoots: [
        this.params.runtimePaths.remoteWorkspaceDir,
        this.params.runtimePaths.remoteAgentWorkspaceDir,
      ],
      buildExecSpec: async ({ command, workdir, env, usePty }) => {
        const remoteCommand = buildValidatedExecRemoteCommand({
          command,
          workdir: workdir ?? this.params.runtimePaths.remoteWorkspaceDir,
          env,
        });
        await this.ensureRuntime();
        const session = await this.getSession();
        const { keypair, cert, forwarder } = await this.ensureSshTransport(session);
        return {
          argv: buildSshExecArgv({
            privateKeyPath: keypair.privateKeyPath,
            certificatePath: cert.certificatePath,
            port: forwarder.port,
            usePty,
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
          runtime: {
            remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
            remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
            runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
          },
        }),
    };
  }

  private async getSession(): Promise<Session> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.getSessionInner().catch((error: unknown) => {
        this.sessionPromise = null;
        throw error;
      });
    }
    return await this.sessionPromise;
  }

  /** Ensure keypair, a valid per-session edge certificate, and the loopback forwarder. */
  private async ensureSshTransport(session: Session): Promise<{
    keypair: TenkiSshKeypair;
    cert: TenkiSshSessionCert;
    forwarder: TenkiSshForwarder;
  }> {
    this.sshKeypairPromise ??= ensureTenkiSshKeypair();
    const keypair = await this.sshKeypairPromise;
    this.sshForwarderPromise ??= startTenkiSshForwarder(async () => await this.getSession());
    const forwarder = await this.sshForwarderPromise;
    // Certs are short-lived and bound to one session: mint on first use, after
    // session recreation, and again once the previous cert nears expiry.
    if (
      !this.sshCert ||
      this.sshCertSessionId !== session.id ||
      shouldRenewSessionSshCert(this.sshCert)
    ) {
      const isNewSession = this.sshCertSessionId !== session.id;
      this.sshCert = await mintSessionSshCert({
        client: createTenkiClient(this.cfg),
        sessionId: session.id,
        publicKey: keypair.publicKey,
      });
      this.sshCertSessionId = session.id;
      if (isNewSession) {
        // Guard first-connect readiness so the first real exec does not race
        // gateway-side session registration.
        await waitForSshAuth({
          privateKeyPath: keypair.privateKeyPath,
          certificatePath: this.sshCert.certificatePath,
          port: forwarder.port,
        });
      }
    }
    return { keypair, cert: this.sshCert, forwarder };
  }

  private async getSessionInner(): Promise<Session> {
    const client = createTenkiClient(this.cfg);
    const existing = await findRuntimeSessions(this.cfg, this.params.runtimePaths.runtimeId);
    const reusable = existing[0];
    if (reusable) {
      if (reusable.state === "PAUSED") {
        await reusable.resume();
      }
      await reusable.waitReady();
      return reusable;
    }
    return await client.create({
      name: this.params.runtimePaths.runtimeId,
      tags: [TENKI_SESSION_TAG, this.params.runtimePaths.runtimeId, ...this.cfg.tags],
      projectId: this.cfg.projectId,
      workspaceId: this.cfg.workspaceId,
      image: this.cfg.image,
      idleTimeoutMinutes: this.cfg.idleTimeoutMinutes,
      cpuCores: this.cfg.cpuCores,
      memoryMb: this.cfg.memoryMb,
      diskSizeGb: this.cfg.diskSizeGb,
      allowOutbound: true,
    });
  }

  private async ensureRuntime(): Promise<void> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    // Concurrent exec/fs calls share one workspace bootstrap; failures reset the
    // promise so the next call can retry after transient API errors.
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<void> {
    const session = await this.getSession();
    const exists = await this.execShell(session, {
      script: 'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
      args: [this.params.runtimePaths.runtimeRootDir],
    });
    if (exists.stdout.toString("utf8").trim() === "1") {
      return;
    }
    await this.uploadDirectory(
      session,
      this.params.createParams.workspaceDir,
      this.params.runtimePaths.remoteWorkspaceDir,
    );
    if (
      this.params.createParams.cfg.workspaceAccess !== "none" &&
      path.resolve(this.params.createParams.agentWorkspaceDir) !==
        path.resolve(this.params.createParams.workspaceDir)
    ) {
      await this.uploadDirectory(
        session,
        this.params.createParams.agentWorkspaceDir,
        this.params.runtimePaths.remoteAgentWorkspaceDir,
      );
    }
    await this.refreshSkillsWorkspace(session);
  }

  // Draft limitation: the skills workspace is uploaded once when the runtime root
  // is first created; the SSH backend refreshes it before each exec.
  private async refreshSkillsWorkspace(session: Session): Promise<void> {
    if (
      this.params.createParams.cfg.workspaceAccess !== "rw" ||
      !this.params.createParams.skillsWorkspaceDir ||
      !(await isExistingDirectory(this.params.createParams.skillsWorkspaceDir))
    ) {
      return;
    }
    await this.uploadDirectory(
      session,
      this.params.createParams.skillsWorkspaceDir,
      this.params.runtimePaths.remoteSkillsWorkspaceDir,
    );
  }

  private async validateWorkdir(workdir: string): Promise<string | null> {
    await this.ensureRuntime();
    const session = await this.getSession();
    const result = await this.execShell(session, {
      script: VALIDATE_REMOTE_WORKDIR_SCRIPT,
      args: [workdir, this.resolveWorkdirValidationRoot(workdir)],
      allowFailure: true,
    });
    const resolved = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
    return resolved || null;
  }

  private resolveWorkdirValidationRoot(workdir: string): string {
    const roots = [
      this.params.runtimePaths.remoteAgentWorkspaceDir,
      this.params.runtimePaths.remoteWorkspaceDir,
    ];
    return (
      roots.find((root) => isRemotePathInsideRoot(root, workdir)) ??
      this.params.runtimePaths.remoteWorkspaceDir
    );
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    await this.ensureRuntime();
    const session = await this.getSession();
    return await this.execShell(session, params);
  }

  private async execShell(
    session: Session,
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    let script = params.script;
    let env: Record<string, string> | undefined;
    if (params.stdin !== undefined) {
      // The SDK exec surface has no stdin stream; stage it as a session file and
      // redirect fd 0 before the script runs. rm-after-open is safe on Linux.
      const stdinFile = `${TENKI_SESSION_WORKDIR}/.openclaw-stdin-${randomUUID()}`;
      await session.writeFile(
        stdinFile,
        typeof params.stdin === "string" ? params.stdin : new Uint8Array(params.stdin),
      );
      env = { OPENCLAW_STDIN_FILE: stdinFile };
      script = `exec 0<"$OPENCLAW_STDIN_FILE" && rm -f -- "$OPENCLAW_STDIN_FILE"\n${script}`;
    }
    script = `${buildPositionalArgsPrefix(params.args)}${script}`;
    const result = await session.exec("/bin/sh", {
      args: ["-c", script],
      env,
      signal: params.signal,
    });
    const stdout = Buffer.from(result.stdout);
    const stderr = Buffer.from(result.stderr);
    if (result.status === "TIMED_OUT") {
      throw new Error(`Tenki sandbox command timed out: ${stderr.toString("utf8")}`);
    }
    if (!params.allowFailure && result.exitCode !== 0) {
      throw new Error(
        `Tenki sandbox command failed (${result.exitCode}): ${stderr.toString("utf8")}`,
      );
    }
    return { stdout, stderr, code: result.exitCode };
  }

  private async uploadDirectory(
    session: Session,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    const tarball = await createLocalTarball(localDir);
    const remoteTar = `${TENKI_SESSION_WORKDIR}/.openclaw-upload-${randomUUID()}.tar`;
    await session.writeFile(remoteTar, tarball);
    await this.execShell(session, {
      script: `${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\nfind "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +\ntar -xf "$3" -C "$1"\nrm -f -- "$3"`,
      args: [remoteDir, this.params.runtimePaths.runtimeRootDir, remoteTar],
    });
  }
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRemotePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}

function isRemotePathInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedCandidate = normalizeRemotePath(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    (normalizedRoot === "/"
      ? normalizedCandidate.startsWith("/")
      : normalizedCandidate.startsWith(`${normalizedRoot}/`))
  );
}

export function resolveTenkiRuntimePaths(
  workspaceRoot: string,
  scopeKey: string,
): ResolvedTenkiRuntimePaths {
  const runtimeId = buildTenkiSandboxRuntimeId(scopeKey);
  const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
  return {
    runtimeId,
    runtimeRootDir,
    remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
    remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent"),
    remoteSkillsWorkspaceDir: path.posix.join(
      runtimeRootDir,
      "workspace",
      ".openclaw",
      "sandbox-skills",
    ),
  };
}

function buildTenkiSandboxRuntimeId(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  // Keep the id human-readable while hashing the original scope to avoid
  // collisions after normalization and truncation. The id doubles as a Tenki
  // session tag, and Tenki caps tags at 32 characters: 9 (prefix) + 14 + 1 + 8.
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `oc-tenki-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
