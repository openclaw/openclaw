import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { PermissionDeniedError, PermissionPromptUnavailableError } from "../errors.js";
import type {
  ClientOperation,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../runtime-types.js";
import { promptForPermission } from "./permission-prompt.js";
import { buildSpawnCommandOptions } from "./spawn.js";

const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_500;

type ManagedTerminal = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  resolveExit: (response: WaitForTerminalExitResponse) => void;
};

export type TerminalManagerOptions = {
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  onOperation?: (operation: ClientOperation) => void;
  confirmExecute?: (commandLine: string) => Promise<boolean>;
  killGraceMs?: number;
};

type TerminalSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  stdio: ["ignore", "pipe", "pipe"];
  shell?: true;
  windowsHide: true;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toCommandLine(command: string, args: string[] | undefined): string {
  const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
  return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}

function toEnvObject(env: CreateTerminalRequest["env"]): NodeJS.ProcessEnv | undefined {
  if (!env || env.length === 0) {
    return undefined;
  }

  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of env) {
    merged[entry.name] = entry.value;
  }
  return merged;
}

export function buildTerminalSpawnOptions(
  command: string,
  cwd: string,
  env: CreateTerminalRequest["env"],
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnOptions {
  const resolvedEnv = toEnvObject(env);
  const options: TerminalSpawnOptions = {
    cwd,
    env: resolvedEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  return buildSpawnCommandOptions(
    command,
    options,
    platform,
    resolvedEnv ?? process.env,
  ) as TerminalSpawnOptions;
}

function trimToUtf8Boundary(buffer: Buffer, limit: number): Buffer {
  if (limit <= 0) {
    return Buffer.alloc(0);
  }
  if (buffer.length <= limit) {
    return buffer;
  }

  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }

  if (start >= buffer.length) {
    start = buffer.length - limit;
  }
  return buffer.subarray(start);
}

function waitForSpawn(process: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      process.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      process.off("spawn", onSpawn);
      reject(error);
    };

    process.once("spawn", onSpawn);
    process.once("error", onError);
  });
}

async function defaultConfirmExecute(commandLine: string): Promise<boolean> {
  return await promptForPermission({
    prompt: `\n[permission] Allow terminal command "${commandLine}"? (y/N) `,
  });
}

function canPromptForPermission(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export class TerminalManager {
  private readonly cwd: string;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissionPolicy;
  private readonly onOperation?: (operation: ClientOperation) => void;
  private readonly usesDefaultConfirmExecute: boolean;
  private readonly confirmExecute: (commandLine: string) => Promise<boolean>;
  private readonly killGraceMs: number;
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(options: TerminalManagerOptions) {
    this.cwd = options.cwd;
    this.permissionMode = options.permissionMode;
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
    this.onOperation = options.onOperation;
    this.usesDefaultConfirmExecute = options.confirmExecute == null;
    this.confirmExecute = options.confirmExecute ?? defaultConfirmExecute;
    this.killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  }

  updatePermissionPolicy(
    permissionMode: PermissionMode,
    nonInteractivePermissions?: NonInteractivePermissionPolicy,
  ): void {
    this.permissionMode = permissionMode;
    this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const commandLine = toCommandLine(params.command, params.args);
    const summary = `terminal/create: ${commandLine}`;

    this.emitOperation({
      method: "terminal/create",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    try {
      if (!(await this.isExecuteApproved(commandLine))) {
        throw new PermissionDeniedError("Permission denied for terminal/create");
      }

      const outputByteLimit = Math.max(
        0,
        Math.round(params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES),
      );
      const proc = spawn(
        params.command,
        params.args ?? [],
        buildTerminalSpawnOptions(params.command, params.cwd ?? this.cwd, params.env),
      );
      await waitForSpawn(proc);

      let resolveExit: (response: WaitForTerminalExitResponse) => void = () => {};
      const exitPromise = new Promise<WaitForTerminalExitResponse>((resolve) => {
        resolveExit = resolve;
      });

      const terminal: ManagedTerminal = {
        process: proc,
        output: Buffer.alloc(0),
        truncated: false,
        outputByteLimit,
        exitCode: undefined,
        signal: undefined,
        exitPromise,
        resolveExit,
      };

      const appendOutput = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length === 0) {
          return;
        }

        terminal.output = Buffer.concat([terminal.output, bytes]);
        if (terminal.output.length > terminal.outputByteLimit) {
          terminal.output = trimToUtf8Boundary(terminal.output, terminal.outputByteLimit);
          terminal.truncated = true;
        }
      };

      proc.stdout.on("data", appendOutput);
      proc.stderr.on("data", appendOutput);
      proc.once("exit", (exitCode, signal) => {
        terminal.exitCode = exitCode;
        terminal.signal = signal;
        terminal.resolveExit({
          exitCode: exitCode ?? null,
          signal: signal ?? null,
        });
      });

      const terminalId = randomUUID();
      this.terminals.set(terminalId, terminal);

      this.emitOperation({
        method: "terminal/create",
        status: "completed",
        summary,
        details: `terminalId=${terminalId}`,
        timestamp: nowIso(),
      });
      return { terminalId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/create",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const hasExitStatus = terminal.exitCode !== undefined || terminal.signal !== undefined;

    this.emitOperation({
      method: "terminal/output",
      status: "completed",
      summary: `terminal/output: ${params.terminalId}`,
      timestamp: nowIso(),
    });

    return {
      output: terminal.output.toString("utf8"),
      truncated: terminal.truncated,
      exitStatus: hasExitStatus
        ? {
            exitCode: terminal.exitCode ?? null,
            signal: terminal.signal ?? null,
          }
        : undefined,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const response = await terminal.exitPromise;
    this.emitOperation({
      method: "terminal/wait_for_exit",
      status: "completed",
      summary: `terminal/wait_for_exit: ${params.terminalId}`,
      details: `exitCode=${response.exitCode ?? "null"}, signal=${response.signal ?? "null"}`,
      timestamp: nowIso(),
    });
    return response;
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const summary = `terminal/kill: ${params.terminalId}`;
    this.emitOperation({
      method: "terminal/kill",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    try {
      await this.killProcess(terminal);
      this.emitOperation({
        method: "terminal/kill",
        status: "completed",
        summary,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/kill",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const summary = `terminal/release: ${params.terminalId}`;
    this.emitOperation({
      method: "terminal/release",
      status: "running",
      summary,
      timestamp: nowIso(),
    });

    const terminal = this.getTerminal(params.terminalId);
    if (!terminal) {
      this.emitOperation({
        method: "terminal/release",
        status: "completed",
        summary,
        details: "already released",
        timestamp: nowIso(),
      });
      return {};
    }

    try {
      await this.killProcess(terminal);
      await terminal.exitPromise.catch(() => {
        // ignore best-effort wait failures
      });
      terminal.output = Buffer.alloc(0);
      this.terminals.delete(params.terminalId);

      this.emitOperation({
        method: "terminal/release",
        status: "completed",
        summary,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "terminal/release",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    for (const terminalId of Array.from(this.terminals.keys())) {
      await this.releaseTerminal({ terminalId, sessionId: "shutdown" });
    }
  }

  private getTerminal(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  private emitOperation(operation: ClientOperation): void {
    this.onOperation?.(operation);
  }

  private async isExecuteApproved(commandLine: string): Promise<boolean> {
    if (this.permissionMode === "approve-all") {
      return true;
    }
    if (this.permissionMode === "deny-all") {
      return false;
    }
    if (
      this.usesDefaultConfirmExecute &&
      this.nonInteractivePermissions === "fail" &&
      !canPromptForPermission()
    ) {
      throw new PermissionPromptUnavailableError();
    }
    return await this.confirmExecute(commandLine);
  }

  private isRunning(terminal: ManagedTerminal): boolean {
    return terminal.exitCode === undefined && terminal.signal === undefined;
  }

  private async killProcess(terminal: ManagedTerminal): Promise<void> {
    if (!this.isRunning(terminal)) {
      return;
    }

    try {
      terminal.process.kill("SIGTERM");
    } catch {
      return;
    }

    const exitedAfterTerm = await Promise.race([
      terminal.exitPromise.then(() => true),
      waitMs(this.killGraceMs).then(() => false),
    ]);

    if (exitedAfterTerm || !this.isRunning(terminal)) {
      return;
    }

    try {
      terminal.process.kill("SIGKILL");
    } catch {
      return;
    }

    await Promise.race([terminal.exitPromise.then(() => undefined), waitMs(this.killGraceMs)]);
  }
}
