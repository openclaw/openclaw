// sbx plugin module implements cli behavior.
import { spawn } from "node:child_process";
import {
  runPluginCommandWithTimeout,
  type SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedSbxPluginConfig } from "./config.js";

const SBX_FS_SCRIPT_LABEL = "openclaw-sbx-fs";

export type SbxExecContext = {
  config: ResolvedSbxPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

export function buildSbxBaseArgv(config: ResolvedSbxPluginConfig): string[] {
  return [config.command];
}

/** Run a one-shot sbx CLI command (create, ls, rm) and capture text output. */
export async function runSbxCli(params: {
  context: SbxExecContext;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runPluginCommandWithTimeout({
    argv: [...buildSbxBaseArgv(params.context.config), ...params.args],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
    env: process.env,
  });
}

/**
 * Build the argv core spawns for an interactive exec. Mirrors the Docker
 * backend's login-shell + PATH handling so custom PATH survives /etc/profile.
 */
export function buildSbxExecArgv(params: {
  config: ResolvedSbxPluginConfig;
  sandboxName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  usePty: boolean;
}): string[] {
  const args = [...buildSbxBaseArgv(params.config), "exec", "-i"];
  if (params.usePty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  if (params.config.user) {
    args.push("-u", params.config.user);
  }
  for (const [key, value] of Object.entries(params.env)) {
    // Skip PATH: a host PATH (for example Windows paths) passed via -e poisons
    // executable lookup inside the sandbox. It is reattached below instead.
    if (key === "PATH") {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }
  const hasCustomPath = typeof params.env.PATH === "string" && params.env.PATH.length > 0;
  if (hasCustomPath) {
    args.push("-e", `OPENCLAW_PREPEND_PATH=${params.env.PATH}`);
  }
  // A login shell (-l) sources /etc/profile, which resets PATH; re-prepend the
  // custom PATH afterwards so custom tools stay reachable.
  const pathExport = hasCustomPath
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  args.push(params.sandboxName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

/** Run a backend shell command via `sbx exec` and capture raw buffers. */
export function runSbxExecShell(params: {
  config: ResolvedSbxPluginConfig;
  sandboxName: string;
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
}): Promise<SandboxBackendCommandResult> {
  const argv = [
    ...buildSbxBaseArgv(params.config),
    "exec",
    "-i",
    params.sandboxName,
    "sh",
    "-c",
    params.script,
    SBX_FS_SCRIPT_LABEL,
    ...(params.args ?? []),
  ];
  return new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const [command, ...rest] = argv;
    const child = spawn(command, rest, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const handleAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    if (params.signal) {
      if (params.signal.aborted) {
        handleAbort();
      } else {
        params.signal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => {
      params.signal?.removeEventListener("abort", handleAbort);
      reject(error);
    });
    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", handleAbort);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (aborted || params.signal?.aborted) {
        reject(new Error("sbx exec command aborted"));
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !params.allowFailure) {
        const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
        reject(new Error(message || `sbx exec ${params.sandboxName} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    if (params.stdin !== undefined) {
      child.stdin?.end(params.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
