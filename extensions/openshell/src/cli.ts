import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  runPluginCommandWithTimeout,
} from "openclaw/plugin-sdk/core";
import type { SandboxBackendCommandResult } from "openclaw/plugin-sdk/core";
import type { ResolvedOpenShellPluginConfig } from "./config.js";

export type OpenShellExecContext = {
  config: ResolvedOpenShellPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

export type OpenShellSshSession = {
  configPath: string;
  host: string;
};

export type OpenShellRunSshCommandParams = {
  session: OpenShellSshSession;
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  tty?: boolean;
};

export function buildOpenShellBaseArgv(config: ResolvedOpenShellPluginConfig): string[] {
  const argv = [config.command];
  if (config.gateway) {
    argv.push("--gateway", config.gateway);
  }
  if (config.gatewayEndpoint) {
    argv.push("--gateway-endpoint", config.gatewayEndpoint);
  }
  return argv;
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

export async function runOpenShellCli(params: {
  context: OpenShellExecContext;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runPluginCommandWithTimeout({
    argv: [...buildOpenShellBaseArgv(params.context.config), ...params.args],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
    env: process.env,
  });
}

export async function createOpenShellSshSession(params: {
  context: OpenShellExecContext;
}): Promise<OpenShellSshSession> {
  const result = await runOpenShellCli({
    context: params.context,
    args: ["sandbox", "ssh-config", params.context.sandboxName],
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "openshell sandbox ssh-config failed");
  }
  const hostMatch = result.stdout.match(/^\s*Host\s+(\S+)/m);
  const host = hostMatch?.[1]?.trim();
  if (!host) {
    throw new Error("Failed to parse openshell ssh-config output.");
  }
  const tmpRoot = resolvePreferredOpenClawTmpDir() || os.tmpdir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const configDir = await fs.mkdtemp(path.join(tmpRoot, "openclaw-openshell-ssh-"));
  const configPath = path.join(configDir, "config");
  await fs.writeFile(configPath, result.stdout, "utf8");
  return { configPath, host };
}

export async function disposeOpenShellSshSession(session: OpenShellSshSession): Promise<void> {
  await fs.rm(path.dirname(session.configPath), { recursive: true, force: true });
}

export async function runOpenShellSshCommand(
  params: OpenShellRunSshCommandParams,
): Promise<SandboxBackendCommandResult> {
  const argv = [
    "ssh",
    "-F",
    params.session.configPath,
    ...(params.tty
      ? ["-tt", "-o", "RequestTTY=force", "-o", "SetEnv=TERM=xterm-256color"]
      : ["-T", "-o", "RequestTTY=no"]),
    params.session.host,
    params.remoteCommand,
  ];

  const result = await new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      signal: params.signal,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !params.allowFailure) {
        const error = Object.assign(
          new Error(stderr.toString("utf8").trim() || `ssh exited with code ${exitCode}`),
          {
            code: exitCode,
            stdout,
            stderr,
          },
        );
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    if (params.stdin !== undefined) {
      child.stdin.end(params.stdin);
      return;
    }
    child.stdin.end();
  });

  return result;
}

export function buildExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string {
  const body = params.workdir
    ? `cd ${shellEscape(params.workdir)} && ${params.command}`
    : params.command;
  const argv =
    Object.keys(params.env).length > 0
      ? [
          "env",
          ...Object.entries(params.env).map(([key, value]) => `${key}=${value}`),
          "/bin/sh",
          "-c",
          body,
        ]
      : ["/bin/sh", "-c", body];
  return buildRemoteCommand(argv);
}
