import crypto from "node:crypto";
import { parseSshTarget } from "../infra/ssh-tunnel.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ManagedRun } from "../process/supervisor/types.js";
import { splitShellArgs } from "../utils/shell-argv.js";

const REMOTE_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REMOTE_SHELL = "/bin/sh";

export type RemoteExecHost = "remote-ssh" | "remote-container" | "remote-k8s-pod";

export type RemoteExecTarget =
  | {
      host: "remote-ssh";
      sshTarget: string;
      sshIdentity?: string;
      sshShell?: string;
    }
  | {
      host: "remote-container";
      containerName: string;
      containerContext?: string;
      containerSshTarget?: string;
      containerSshIdentity?: string;
      containerShell?: string;
    }
  | {
      host: "remote-k8s-pod";
      k8sContext?: string;
      k8sNamespace: string;
      k8sPod: string;
      k8sContainer?: string;
      k8sShell?: string;
    };

export type RemoteExecRunParams = {
  target: RemoteExecTarget;
  command: string;
  workdir: string;
  env: Record<string, string>;
  timeoutSec: number;
};

export type RemoteExecRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
  durationMs: number;
};

type RemoteSession = {
  key: string;
  run: ManagedRun;
  output: string;
  closed: boolean;
  queue: Promise<void>;
  lastUsedAt: number;
};

const remoteSessions = new Map<string, RemoteSession>();

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteCommandArgs(args: string[]): string {
  return args.map((arg) => shellEscapeArg(arg)).join(" ");
}

function parseShellTokens(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [DEFAULT_REMOTE_SHELL];
  }
  const parsed = splitShellArgs(trimmed);
  if (!parsed || parsed.length === 0) {
    throw new Error(`invalid shell command: ${trimmed}`);
  }
  return parsed;
}

function parseRequiredSshTarget(raw: string) {
  const parsed = parseSshTarget(raw);
  if (!parsed) {
    throw new Error(`invalid SSH target: ${raw}`);
  }
  return parsed;
}

function buildSshConnectArgs(params: {
  sshTarget: string;
  sshIdentity?: string;
  remoteCommand?: string[];
}): string[] {
  const parsed = parseRequiredSshTarget(params.sshTarget);
  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  const args = [
    "/usr/bin/ssh",
    "-tt",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "UpdateHostKeys=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-p",
    String(parsed.port),
  ];
  const identity = params.sshIdentity?.trim();
  if (identity) {
    args.push("-i", identity);
  }
  args.push("--", userHost);
  if (params.remoteCommand && params.remoteCommand.length > 0) {
    args.push(...params.remoteCommand);
  }
  return args;
}

function buildConnectCommand(target: RemoteExecTarget): string {
  if (target.host === "remote-ssh") {
    const shellTokens = parseShellTokens(target.sshShell);
    return quoteCommandArgs(
      buildSshConnectArgs({
        sshTarget: target.sshTarget,
        sshIdentity: target.sshIdentity,
        remoteCommand: shellTokens,
      }),
    );
  }

  if (target.host === "remote-container") {
    const shellTokens = parseShellTokens(target.containerShell);
    if (target.containerContext?.trim()) {
      return quoteCommandArgs([
        "docker",
        "--context",
        target.containerContext.trim(),
        "exec",
        "-it",
        target.containerName,
        ...shellTokens,
      ]);
    }
    if (target.containerSshTarget?.trim()) {
      const dockerExec = ["docker", "exec", "-it", target.containerName, ...shellTokens];
      return quoteCommandArgs(
        buildSshConnectArgs({
          sshTarget: target.containerSshTarget.trim(),
          sshIdentity: target.containerSshIdentity,
          remoteCommand: dockerExec,
        }),
      );
    }
    throw new Error(
      "remote-container requires either containerContext (docker context) or containerSshTarget (container-over-SSH)",
    );
  }

  const shellTokens = parseShellTokens(target.k8sShell);
  const args = ["kubectl"];
  if (target.k8sContext?.trim()) {
    args.push("--context", target.k8sContext.trim());
  }
  args.push("exec", "-n", target.k8sNamespace, "-it", target.k8sPod);
  if (target.k8sContainer?.trim()) {
    args.push("-c", target.k8sContainer.trim());
  }
  args.push("--", ...shellTokens);
  return quoteCommandArgs(args);
}

function buildSessionKey(target: RemoteExecTarget): string {
  if (target.host === "remote-ssh") {
    return [
      "remote-ssh",
      target.sshTarget.trim(),
      target.sshIdentity?.trim() ?? "",
      target.sshShell?.trim() ?? DEFAULT_REMOTE_SHELL,
    ].join("|");
  }
  if (target.host === "remote-container") {
    return [
      "remote-container",
      target.containerName.trim(),
      target.containerContext?.trim() ?? "",
      target.containerSshTarget?.trim() ?? "",
      target.containerSshIdentity?.trim() ?? "",
      target.containerShell?.trim() ?? DEFAULT_REMOTE_SHELL,
    ].join("|");
  }
  return [
    "remote-k8s-pod",
    target.k8sContext?.trim() ?? "",
    target.k8sNamespace.trim(),
    target.k8sPod.trim(),
    target.k8sContainer?.trim() ?? "",
    target.k8sShell?.trim() ?? DEFAULT_REMOTE_SHELL,
  ].join("|");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pruneIdleSessions(now: number) {
  for (const [key, session] of remoteSessions) {
    if (session.closed) {
      remoteSessions.delete(key);
      continue;
    }
    if (now - session.lastUsedAt <= REMOTE_SESSION_IDLE_TTL_MS) {
      continue;
    }
    session.run.cancel("manual-cancel");
    remoteSessions.delete(key);
  }
}

async function writeToSession(run: ManagedRun, data: string): Promise<void> {
  const stdin = run.stdin;
  if (!stdin || stdin.destroyed) {
    throw new Error("remote session stdin is not writable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(data, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function sendInterrupt(run: ManagedRun) {
  const stdin = run.stdin;
  if (!stdin || stdin.destroyed) {
    return;
  }
  try {
    stdin.write("\u0003");
  } catch {
    // Ignore best-effort interrupt failures.
  }
}

async function ensureSession(params: {
  target: RemoteExecTarget;
  workdir: string;
  env: Record<string, string>;
}): Promise<RemoteSession> {
  const now = Date.now();
  pruneIdleSessions(now);
  const key = buildSessionKey(params.target);
  const existing = remoteSessions.get(key);
  if (existing && !existing.closed) {
    existing.lastUsedAt = now;
    return existing;
  }

  const supervisor = getProcessSupervisor();
  const connectCommand = buildConnectCommand(params.target);
  const run = await supervisor.spawn({
    runId: crypto.randomUUID(),
    sessionId: `remote:${key}`,
    backendId: "exec-remote",
    mode: "pty",
    ptyCommand: connectCommand,
    cwd: params.workdir,
    env: params.env,
    captureOutput: false,
    onStdout: (chunk) => {
      const current = remoteSessions.get(key);
      if (!current) {
        return;
      }
      current.output += chunk;
    },
    onStderr: (chunk) => {
      const current = remoteSessions.get(key);
      if (!current) {
        return;
      }
      current.output += chunk;
    },
  });

  const session: RemoteSession = {
    key,
    run,
    output: "",
    closed: false,
    queue: Promise.resolve(),
    lastUsedAt: now,
  };
  remoteSessions.set(key, session);

  void run
    .wait()
    .catch(() => undefined)
    .finally(() => {
      const current = remoteSessions.get(key);
      if (!current) {
        return;
      }
      current.closed = true;
      remoteSessions.delete(key);
    });

  return session;
}

function lockSession<T>(session: RemoteSession, task: () => Promise<T>): Promise<T> {
  const next = session.queue.then(task, task);
  session.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function runRemoteExec(params: RemoteExecRunParams): Promise<RemoteExecRunResult> {
  const startedAt = Date.now();
  const session = await ensureSession({
    target: params.target,
    workdir: params.workdir,
    env: params.env,
  });
  session.lastUsedAt = Date.now();

  return await lockSession(session, async () => {
    session.output = "";
    if (session.closed) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "remote session is closed",
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    }

    const marker = `__OPENCLAW_RC_${crypto.randomUUID().replace(/-/g, "")}__`;
    const markerRegex = new RegExp(`${escapeRegExp(marker)}:(-?\\d+)`);
    const timeoutMs = Math.max(1, Math.floor(params.timeoutSec * 1000));
    const deadline = Date.now() + timeoutMs;
    const payload = `${params.command}\nprintf '\\n${marker}:%s\\n' "$?"\n`;

    try {
      await writeToSession(session.run, payload);
    } catch (err) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: String(err),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    }

    let captured = "";
    while (true) {
      if (session.output.length > 0) {
        captured += session.output;
        session.output = "";
      }
      const match = markerRegex.exec(captured);
      if (match) {
        const exitCode = Number.parseInt(match[1] ?? "", 10);
        const output = captured.slice(0, match.index).replace(/\r/g, "").trimEnd();
        const success = Number.isFinite(exitCode) ? exitCode === 0 : false;
        return {
          success,
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
          stdout: output,
          stderr: "",
          error: success ? undefined : output || `Command exited with code ${exitCode}`,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        };
      }

      if (session.closed) {
        return {
          success: false,
          exitCode: null,
          stdout: captured.trimEnd(),
          stderr: "",
          error: "remote session closed unexpectedly",
          timedOut: false,
          durationMs: Date.now() - startedAt,
        };
      }

      const now = Date.now();
      if (now >= deadline) {
        sendInterrupt(session.run);
        return {
          success: false,
          exitCode: null,
          stdout: captured.trimEnd(),
          stderr: "",
          error: `Command timed out after ${params.timeoutSec} seconds`,
          timedOut: true,
          durationMs: Date.now() - startedAt,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - now)));
    }
  });
}

export function resetRemoteExecSessionsForTests() {
  for (const session of remoteSessions.values()) {
    session.run.cancel("manual-cancel");
  }
  remoteSessions.clear();
}
