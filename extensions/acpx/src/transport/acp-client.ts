import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthMethod,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type SessionModelState,
} from "@agentclientprotocol/sdk";
import { extractAcpError } from "../acp-error-shapes.js";
import { isSessionUpdateNotification } from "../acp-jsonrpc.js";
import {
  AgentDisconnectedError,
  AgentSpawnError,
  AuthPolicyError,
  ClaudeAcpSessionCreateTimeoutError,
  CopilotAcpUnsupportedError,
  GeminiAcpStartupTimeoutError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../errors.js";
import { textPrompt } from "../prompt-content.js";
import { extractRuntimeSessionId } from "../runtime-session-id.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionStats,
  PromptInput,
} from "../runtime-types.js";
import { TimeoutError, withTimeout } from "../session-runtime-helpers.js";
import { FileSystemHandlers } from "./filesystem.js";
import { classifyPermissionDecision, resolvePermissionRequest } from "./permissions.js";
import { buildSpawnCommandOptions } from "./spawn.js";
import { TerminalManager } from "./terminal.js";

export { buildSpawnCommandOptions };

type CommandParts = {
  command: string;
  args: string[];
};

const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;
const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15_000;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 60_000;
const GEMINI_VERSION_TIMEOUT_MS = 2_000;
const GEMINI_ACP_FLAG_VERSION = [0, 33, 0] as const;
const COPILOT_HELP_TIMEOUT_MS = 2_000;
const SESSION_CONTROL_UNSUPPORTED_ACP_CODES = new Set([-32601, -32602]);

type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};

export type SessionCreateResult = {
  sessionId: string;
  agentSessionId?: string;
  models?: SessionModelState;
};

export type SessionLoadResult = {
  agentSessionId?: string;
  models?: SessionModelState;
};

type AgentDisconnectReason = "process_exit" | "process_close" | "pipe_close" | "connection_close";

type PendingConnectionRequest = {
  settled: boolean;
  reject: (error: unknown) => void;
};

type AuthSelection = {
  methodId: string;
  credential: string;
  source: "env" | "config";
};

type GeminiVersion = {
  raw: string;
  parts: [number, number, number];
};

export type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};

export type AgentLifecycleSnapshot = {
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
};

type ConsoleErrorMethod = typeof console.error;
const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

function shouldSuppressSdkConsoleError(args: unknown[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return typeof args[0] === "string" && args[0] === "Error handling request";
}

function installSdkConsoleErrorSuppression(): () => void {
  const originalConsoleError: ConsoleErrorMethod = console.error;
  console.error = (...args: unknown[]) => {
    if (shouldSuppressSdkConsoleError(args)) {
      return;
    }
    originalConsoleError(...args);
  };
  return () => {
    console.error = originalConsoleError;
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null;
}

function requireAgentStdio(child: ChildProcess): ChildProcessByStdio<Writable, Readable, Readable> {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP agent must be spawned with piped stdin/stdout/stderr");
  }
  return child as ChildProcessByStdio<Writable, Readable, Readable>;
}

function waitForChildExit(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildProcessRunning(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.max(0, timeoutMs),
    );

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("close", onExitLike);
      child.off("exit", onExitLike);
      clearTimeout(timer);
      resolve(value);
    };

    const onExitLike = () => {
      finish(true);
    };

    child.once("close", onExitLike);
    child.once("exit", onExitLike);
  });
}

function splitCommandLine(value: string): CommandParts {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Invalid --agent command: unterminated quote");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  if (parts.length === 0) {
    throw new Error("Invalid --agent command: empty command");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function asAbsoluteCwd(cwd: string): string {
  return path.resolve(cwd);
}

function basenameToken(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, "");
}

export function resolveAgentCloseAfterStdinEndMs(agentCommand: string): number {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli"
    ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS
    : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}

export function shouldIgnoreNonJsonAgentOutputLine(
  agentCommand: string,
  trimmedLine: string,
): boolean {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}

function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) {
              continue;
            }
            try {
              const message = JSON.parse(trimmedLine) as AnyMessage;
              controller.enqueue(message);
            } catch (err) {
              console.error("Failed to parse JSON message:", trimmedLine, err);
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

function isGeminiAcpCommand(command: string, args: readonly string[]): boolean {
  return (
    basenameToken(command) === "gemini" &&
    (args.includes("--acp") || args.includes("--experimental-acp"))
  );
}

function isClaudeAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "claude-agent-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("claude-agent-acp"));
}

function isCopilotAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "copilot" && args.includes("--acp");
}

function isQoderAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "qodercli" && args.includes("--acp");
}

function hasCommandFlag(args: readonly string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

function normalizeQoderAllowedToolName(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "bash":
    case "glob":
    case "grep":
    case "ls":
    case "read":
    case "write":
      return tool.trim().toUpperCase();
    default:
      return tool.trim();
  }
}

export function buildQoderAcpCommandArgs(
  initialArgs: readonly string[],
  options: Pick<AcpClientOptions, "sessionOptions">,
): string[] {
  const args = [...initialArgs];
  const sessionOptions = options.sessionOptions;

  if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) {
    args.push(`--max-turns=${sessionOptions.maxTurns}`);
  }

  if (
    Array.isArray(sessionOptions?.allowedTools) &&
    !hasCommandFlag(args, "--allowed-tools") &&
    !hasCommandFlag(args, "--disallowed-tools")
  ) {
    const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
    args.push(`--allowed-tools=${encodedTools}`);
  }

  return args;
}
function resolveGeminiAcpStartupTimeoutMs(): number {
  const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}

function resolveClaudeAcpSessionCreateTimeoutMs(): number {
  const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}

function parseGeminiVersion(value: string | undefined): GeminiVersion | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }

  return {
    raw: normalized,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

async function detectGeminiVersion(command: string): Promise<GeminiVersion | undefined> {
  return await new Promise<GeminiVersion | undefined>((resolve) => {
    const child = spawn(
      command,
      ["--version"],
      buildSpawnCommandOptions(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: GeminiVersion | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, GEMINI_VERSION_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", () => {
      const versionLine = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /\d+\.\d+\.\d+/.test(line));
      finish(parseGeminiVersion(versionLine));
    });
  });
}

async function resolveGeminiCommandArgs(
  command: string,
  args: readonly string[],
): Promise<string[]> {
  if (basenameToken(command) !== "gemini" || !args.includes("--acp")) {
    return [...args];
  }

  const version = await detectGeminiVersion(command);
  if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) {
    return args.map((arg) => (arg === "--acp" ? "--experimental-acp" : arg));
  }

  return [...args];
}

async function readCommandOutput(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(
      command,
      [...args],
      buildSpawnCommandOptions(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", () => {
      finish(`${stdout}\n${stderr}`);
    });
  });
}

async function buildGeminiAcpStartupTimeoutMessage(command: string): Promise<string> {
  const parts = [
    "Gemini CLI ACP startup timed out before initialize completed.",
    "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior.",
  ];

  const version = await detectGeminiVersion(command);
  if (version) {
    parts.push(`Detected Gemini CLI version: ${version.raw}.`);
  }

  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
  }

  parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
  return parts.join(" ");
}

function buildClaudeAcpSessionCreateTimeoutMessage(): string {
  return [
    "Claude ACP session creation timed out before session/new completed.",
    "This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
    "In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback.",
  ].join(" ");
}

async function buildCopilotAcpUnsupportedMessage(command: string): Promise<string> {
  const parts = [
    "GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.",
    "acpx copilot expects a Copilot CLI release that supports --acp --stdio.",
  ];

  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    parts.push("Detected copilot --help output without --acp support.");
  }

  parts.push(
    "Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.",
  );
  return parts.join(" ");
}

async function ensureCopilotAcpSupport(command: string): Promise<void> {
  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    throw new CopilotAcpUnsupportedError(await buildCopilotAcpUnsupportedMessage(command), {
      retryable: false,
    });
  }
}

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildAuthEnvKeys(methodId: string): string[] {
  const token = toEnvToken(methodId);
  const keys = new Set<string>([methodId]);
  if (token) {
    keys.add(token);
    keys.add(`ACPX_AUTH_${token}`);
  }
  return [...keys];
}

const authEnvKeysCache = new Map<string, string[]>();

function authEnvKeys(methodId: string): string[] {
  const cached = authEnvKeysCache.get(methodId);
  if (cached) {
    return cached;
  }
  const keys = buildAuthEnvKeys(methodId);
  authEnvKeysCache.set(methodId, keys);
  return keys;
}

function readEnvCredential(methodId: string): string | undefined {
  for (const key of authEnvKeys(methodId)) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function buildClaudeCodeOptionsMeta(
  options: AcpClientOptions["sessionOptions"],
): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }

  const claudeCodeOptions: Record<string, unknown> = {};
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    claudeCodeOptions.model = options.model;
  }
  if (Array.isArray(options.allowedTools)) {
    claudeCodeOptions.allowedTools = [...options.allowedTools];
  }
  if (typeof options.maxTurns === "number") {
    claudeCodeOptions.maxTurns = options.maxTurns;
  }

  if (Object.keys(claudeCodeOptions).length === 0) {
    return undefined;
  }

  return {
    claudeCode: {
      options: claudeCodeOptions,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isLikelySessionControlUnsupportedError(acp: {
  code: number;
  message: string;
  data?: unknown;
}): boolean {
  if (SESSION_CONTROL_UNSUPPORTED_ACP_CODES.has(acp.code)) {
    return true;
  }

  if (acp.code !== -32603) {
    return false;
  }

  const details = asRecord(acp.data)?.details;
  return typeof details === "string" && details.toLowerCase().includes("invalid params");
}

function formatSessionControlAcpSummary(acp: {
  code: number;
  message: string;
  data?: unknown;
}): string {
  const details = asRecord(acp.data)?.details;
  if (typeof details === "string" && details.trim().length > 0) {
    return `${details.trim()} (ACP ${acp.code}, adapter reported "${acp.message}")`;
  }
  return `${acp.message} (ACP ${acp.code})`;
}

function maybeWrapSessionControlError(
  method: "session/set_mode" | "session/set_config_option" | "session/set_model",
  error: unknown,
  context?: string,
): unknown {
  const acp = extractAcpError(error);
  if (!acp || !isLikelySessionControlUnsupportedError(acp)) {
    return error;
  }

  const acpSummary = formatSessionControlAcpSummary(acp);
  const contextSuffix = context ? ` ${context}` : "";
  const message =
    `Agent rejected ${method}${contextSuffix}: ${acpSummary}. ` +
    `The adapter may not implement ${method}, or the requested value is not supported.`;
  const wrapped = new Error(message, {
    cause: error instanceof Error ? error : undefined,
  }) as Error & {
    acp?: typeof acp;
  };
  wrapped.acp = acp;
  return wrapped;
}

function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    if (typeof credential !== "string" || credential.trim().length === 0) {
      continue;
    }

    if (!methodId.includes("=") && !methodId.includes("\u0000") && env[methodId] == null) {
      env[methodId] = credential;
    }

    const normalized = toEnvToken(methodId);
    if (normalized) {
      const prefixed = `ACPX_AUTH_${normalized}`;
      if (env[prefixed] == null) {
        env[prefixed] = credential;
      }
      if (env[normalized] == null) {
        env[normalized] = credential;
      }
    }
  }

  return env;
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(authCredentials),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

export class AcpClient {
  private options: AcpClientOptions;
  private connection?: ClientSideConnection;
  private agent?: ChildProcessByStdio<Writable, Readable, Readable>;
  private initResult?: InitializeResponse;
  private loadedSessionId?: string;
  private eventHandlers: Pick<
    AcpClientOptions,
    "onAcpMessage" | "onAcpOutputMessage" | "onSessionUpdate" | "onClientOperation"
  >;
  private readonly permissionStats: PermissionStats = {
    requested: 0,
    approved: 0,
    denied: 0,
    cancelled: 0,
  };
  private readonly filesystem: FileSystemHandlers;
  private readonly terminalManager: TerminalManager;
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private suppressSessionUpdates = false;
  private suppressReplaySessionUpdateMessages = false;
  private activePrompt?: {
    sessionId: string;
    promise: Promise<PromptResponse>;
  };
  private readonly cancellingSessionIds = new Set<string>();
  private closing = false;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private readonly promptPermissionFailures = new Map<string, PermissionPromptUnavailableError>();
  private readonly pendingConnectionRequests = new Set<PendingConnectionRequest>();

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
      authPolicy: options.authPolicy ?? "skip",
    };
    this.eventHandlers = {
      onAcpMessage: this.options.onAcpMessage,
      onAcpOutputMessage: this.options.onAcpOutputMessage,
      onSessionUpdate: this.options.onSessionUpdate,
      onClientOperation: this.options.onClientOperation,
    };

    this.filesystem = new FileSystemHandlers({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
    this.terminalManager = new TerminalManager({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.initResult;
  }

  getAgentPid(): number | undefined {
    return this.agent?.pid ?? this.lastKnownPid;
  }

  getPermissionStats(): PermissionStats {
    return { ...this.permissionStats };
  }

  getAgentLifecycleSnapshot(): AgentLifecycleSnapshot {
    const pid = this.agent?.pid ?? this.lastKnownPid;
    const running =
      Boolean(this.agent) &&
      this.agent?.exitCode == null &&
      this.agent?.signalCode == null &&
      !this.agent?.killed;
    return {
      pid,
      startedAt: this.agentStartedAt,
      running,
      lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : undefined,
    };
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.loadSession);
  }

  setEventHandlers(
    handlers: Pick<
      AcpClientOptions,
      "onAcpMessage" | "onAcpOutputMessage" | "onSessionUpdate" | "onClientOperation"
    >,
  ): void {
    this.eventHandlers = { ...handlers };
  }

  clearEventHandlers(): void {
    this.eventHandlers = {};
  }

  updateRuntimeOptions(options: {
    permissionMode?: PermissionMode;
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    suppressSdkConsoleErrors?: boolean;
    verbose?: boolean;
  }): void {
    if (options.permissionMode) {
      this.options.permissionMode = options.permissionMode;
    }
    if (options.nonInteractivePermissions !== undefined) {
      this.options.nonInteractivePermissions = options.nonInteractivePermissions;
    }
    if (options.permissionMode || options.nonInteractivePermissions !== undefined) {
      this.filesystem.updatePermissionPolicy(
        this.options.permissionMode,
        this.options.nonInteractivePermissions,
      );
      this.terminalManager.updatePermissionPolicy(
        this.options.permissionMode,
        this.options.nonInteractivePermissions,
      );
    }
    if (options.suppressSdkConsoleErrors !== undefined) {
      this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    }
    if (options.verbose !== undefined) {
      this.options.verbose = options.verbose;
    }
  }

  hasReusableSession(sessionId: string): boolean {
    return (
      this.connection != null &&
      this.agent != null &&
      isChildProcessRunning(this.agent) &&
      this.loadedSessionId === sessionId
    );
  }

  hasActivePrompt(sessionId?: string): boolean {
    if (!this.activePrompt) {
      return false;
    }
    if (sessionId == null) {
      return true;
    }
    return this.activePrompt.sessionId === sessionId;
  }

  async start(): Promise<void> {
    if (this.connection && this.agent && isChildProcessRunning(this.agent)) {
      return;
    }
    if (this.connection || this.agent) {
      await this.close();
    }

    const { command, args: initialArgs } = splitCommandLine(this.options.agentCommand);
    let args = await resolveGeminiCommandArgs(command, initialArgs);
    if (isQoderAcpCommand(command, args)) {
      args = buildQoderAcpCommandArgs(args, this.options);
    }
    this.log(`spawning agent: ${command} ${args.join(" ")}`);
    const geminiAcp = isGeminiAcpCommand(command, args);
    const copilotAcp = isCopilotAcpCommand(command, args);

    if (copilotAcp) {
      await ensureCopilotAcpSupport(command);
    }

    const spawnedChild = spawn(
      command,
      args,
      buildSpawnCommandOptions(
        command,
        buildAgentSpawnOptions(this.options.cwd, this.options.authCredentials),
      ),
    ) as ChildProcessByStdio<Writable, Readable, Readable>;

    try {
      await waitForSpawn(spawnedChild);
    } catch (error) {
      throw new AgentSpawnError(this.options.agentCommand, error);
    }
    const child = requireAgentStdio(spawnedChild);
    this.closing = false;
    this.agentStartedAt = isoNow();
    this.lastAgentExit = undefined;
    this.lastKnownPid = child.pid ?? undefined;
    this.attachAgentLifecycleObservers(child);

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!this.options.verbose) {
        return;
      }
      process.stderr.write(chunk);
    });

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = this.createTappedStream(
      createNdJsonMessageStream(this.options.agentCommand, input, output),
    );

    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          await this.handleSessionUpdate(params);
        },
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return this.handlePermissionRequest(params);
        },
        readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
          return this.handleReadTextFile(params);
        },
        writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
          return this.handleWriteTextFile(params);
        },
        createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
          return this.handleCreateTerminal(params);
        },
        terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
          return this.handleTerminalOutput(params);
        },
        waitForTerminalExit: async (
          params: WaitForTerminalExitRequest,
        ): Promise<WaitForTerminalExitResponse> => {
          return this.handleWaitForTerminalExit(params);
        },
        killTerminal: async (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
          return this.handleKillTerminal(params);
        },
        releaseTerminal: async (
          params: ReleaseTerminalRequest,
        ): Promise<ReleaseTerminalResponse> => {
          return this.handleReleaseTerminal(params);
        },
      }),
      stream,
    );
    connection.signal.addEventListener(
      "abort",
      () => {
        this.recordAgentExit("connection_close", child.exitCode ?? null, child.signalCode ?? null);
      },
      { once: true },
    );

    try {
      const initializePromise = connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: "acpx",
          version: "0.1.0",
        },
      });
      const initResult = geminiAcp
        ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs())
        : await initializePromise;

      await this.authenticateIfRequired(connection, initResult.authMethods ?? []);

      this.connection = connection;
      this.agent = child;
      this.initResult = initResult;
      this.log(`initialized protocol version ${initResult.protocolVersion}`);
    } catch (error) {
      child.kill();
      if (geminiAcp && error instanceof TimeoutError) {
        throw new GeminiAcpStartupTimeoutError(await buildGeminiAcpStartupTimeoutMessage(command), {
          cause: error,
          retryable: true,
        });
      }
      throw error;
    }
  }

  private createTappedStream(base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }): {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  } {
    const onAcpMessage = () => this.eventHandlers.onAcpMessage;
    const onAcpOutputMessage = () => this.eventHandlers.onAcpOutputMessage;

    const shouldSuppressInboundReplaySessionUpdate = (message: AnyMessage): boolean => {
      return this.suppressReplaySessionUpdateMessages && isSessionUpdateNotification(message);
    };

    const readable = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = base.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            if (!shouldSuppressInboundReplaySessionUpdate(value)) {
              onAcpOutputMessage()?.("inbound", value);
              onAcpMessage()?.("inbound", value);
            }
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    const writable = new WritableStream<AnyMessage>({
      async write(message) {
        onAcpOutputMessage()?.("outbound", message);
        onAcpMessage()?.("outbound", message);
        const writer = base.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
    });

    return { readable, writable };
  }

  async createSession(cwd = this.options.cwd): Promise<SessionCreateResult> {
    const connection = this.getConnection();
    const { command, args } = splitCommandLine(this.options.agentCommand);
    const claudeAcp = isClaudeAcpCommand(command, args);

    let result: Awaited<ReturnType<typeof connection.newSession>>;
    try {
      const createPromise = this.runConnectionRequest(() =>
        connection.newSession({
          cwd: asAbsoluteCwd(cwd),
          mcpServers: this.options.mcpServers ?? [],
          _meta: buildClaudeCodeOptionsMeta(this.options.sessionOptions),
        }),
      );
      result = claudeAcp
        ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs())
        : await createPromise;
    } catch (error) {
      if (claudeAcp && error instanceof TimeoutError) {
        throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
          cause: error,
          retryable: true,
        });
      }
      throw error;
    }

    this.loadedSessionId = result.sessionId;

    return {
      sessionId: result.sessionId,
      agentSessionId: extractRuntimeSessionId(result._meta),
      models: result.models ?? undefined,
    };
  }

  async loadSession(sessionId: string, cwd = this.options.cwd): Promise<SessionLoadResult> {
    this.getConnection();
    return await this.loadSessionWithOptions(sessionId, cwd, {});
  }

  async loadSessionWithOptions(
    sessionId: string,
    cwd = this.options.cwd,
    options: LoadSessionOptions = {},
  ): Promise<SessionLoadResult> {
    const connection = this.getConnection();
    const previousSuppression = this.suppressSessionUpdates;
    const previousReplaySuppression = this.suppressReplaySessionUpdateMessages;
    this.suppressSessionUpdates = previousSuppression || Boolean(options.suppressReplayUpdates);
    this.suppressReplaySessionUpdateMessages =
      previousReplaySuppression || Boolean(options.suppressReplayUpdates);

    let response: LoadSessionResponse | undefined;

    try {
      response = await this.runConnectionRequest(() =>
        connection.loadSession({
          sessionId,
          cwd: asAbsoluteCwd(cwd),
          mcpServers: this.options.mcpServers ?? [],
        }),
      );

      await this.waitForSessionUpdateDrain(
        options.replayIdleMs ?? REPLAY_IDLE_MS,
        options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS,
      );
    } finally {
      this.suppressSessionUpdates = previousSuppression;
      this.suppressReplaySessionUpdateMessages = previousReplaySuppression;
    }

    this.loadedSessionId = sessionId;

    return {
      agentSessionId: extractRuntimeSessionId(response?._meta),
      models: response?.models ?? undefined,
    };
  }

  async prompt(sessionId: string, prompt: PromptInput | string): Promise<PromptResponse> {
    const connection = this.getConnection();
    const restoreConsoleError = this.options.suppressSdkConsoleErrors
      ? installSdkConsoleErrorSuppression()
      : undefined;

    let promptPromise: Promise<PromptResponse>;
    try {
      promptPromise = this.runConnectionRequest(() =>
        connection.prompt({
          sessionId,
          prompt: typeof prompt === "string" ? textPrompt(prompt) : prompt,
        }),
      );
    } catch (error) {
      restoreConsoleError?.();
      throw error;
    }

    this.activePrompt = {
      sessionId,
      promise: promptPromise,
    };

    try {
      const response = await promptPromise;
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      return response;
    } catch (error) {
      const permissionFailure = this.consumePromptPermissionFailure(sessionId);
      if (permissionFailure) {
        throw permissionFailure;
      }
      throw error;
    } finally {
      restoreConsoleError?.();
      if (this.activePrompt?.promise === promptPromise) {
        this.activePrompt = undefined;
      }
      this.cancellingSessionIds.delete(sessionId);
      this.promptPermissionFailures.delete(sessionId);
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.setSessionMode({
          sessionId,
          modeId,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`);
    }
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = this.getConnection();
    try {
      return await this.runConnectionRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError(
        "session/set_config_option",
        error,
        `for "${configId}"="${value}"`,
      );
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.unstable_setSessionModel({
          sessionId,
          modelId,
        }),
      );
    } catch (error) {
      const wrapped = maybeWrapSessionControlError(
        "session/set_model",
        error,
        `for model "${modelId}"`,
      );
      if (wrapped !== error) {
        throw wrapped;
      }
      const acp = extractAcpError(error);
      const summary = acp
        ? formatSessionControlAcpSummary(acp)
        : error instanceof Error
          ? error.message
          : String(error);
      if (error instanceof Error) {
        throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
          cause: error,
        });
      }
      throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
        cause: error,
      });
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    this.cancellingSessionIds.add(sessionId);
    await this.runConnectionRequest(() =>
      connection.cancel({
        sessionId,
      }),
    );
  }

  async requestCancelActivePrompt(): Promise<boolean> {
    const active = this.activePrompt;
    if (!active) {
      return false;
    }
    await this.cancel(active.sessionId);
    return true;
  }

  async cancelActivePrompt(waitMs = 2_500): Promise<PromptResponse | undefined> {
    const active = this.activePrompt;
    if (!active) {
      return undefined;
    }

    try {
      await this.cancel(active.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send session/cancel: ${message}`);
    }

    if (waitMs <= 0) {
      return undefined;
    }

    let timer: NodeJS.Timeout | number | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });

    try {
      return await Promise.race([
        active.promise.then(
          (response) => response,
          () => undefined,
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;

    await this.terminalManager.shutdown();

    const agent = this.agent;
    if (agent) {
      await this.terminateAgentProcess(agent);
    }
    if (this.pendingConnectionRequests.size > 0) {
      this.rejectPendingConnectionRequests(
        this.lastAgentExit
          ? new AgentDisconnectedError(
              this.lastAgentExit.reason,
              this.lastAgentExit.exitCode,
              this.lastAgentExit.signal,
              {
                outputAlreadyEmitted: Boolean(this.activePrompt),
              },
            )
          : new AgentDisconnectedError("connection_close", null, null, {
              outputAlreadyEmitted: Boolean(this.activePrompt),
            }),
      );
    }

    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.suppressSessionUpdates = false;
    this.suppressReplaySessionUpdateMessages = false;
    this.activePrompt = undefined;
    this.cancellingSessionIds.clear();
    this.promptPermissionFailures.clear();
    this.loadedSessionId = undefined;
    this.initResult = undefined;
    this.connection = undefined;
    this.agent = undefined;
  }

  private async terminateAgentProcess(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): Promise<void> {
    const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);

    // Closing stdin is the most graceful shutdown signal for stdio-based ACP agents.
    if (!child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // best effort
      }
    }

    let exited = await waitForChildExit(child, stdinCloseGraceMs);
    if (!exited && isChildProcessRunning(child)) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
    }

    if (!exited && isChildProcessRunning(child)) {
      this.log(`agent did not exit after ${AGENT_CLOSE_TERM_GRACE_MS}ms; forcing SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
      exited = await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS);
    }

    // Ensure stdio handles don't keep this process alive after close() returns.
    this.detachAgentHandles(child, !exited);
  }

  private detachAgentHandles(agent: ChildProcess, unref: boolean): void {
    const stdin = agent.stdin;
    const stdout = agent.stdout;
    const stderr = agent.stderr;

    stdin?.destroy();
    stdout?.destroy();
    stderr?.destroy();

    if (unref) {
      try {
        agent.unref();
      } catch {
        // best effort
      }
    }
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP client not started");
    }
    return this.connection;
  }

  private log(message: string): void {
    if (!this.options.verbose) {
      return;
    }
    process.stderr.write(`[acpx] ${message}\n`);
  }

  private selectAuthMethod(methods: AuthMethod[]): AuthSelection | undefined {
    const configCredentials = this.options.authCredentials ?? {};

    for (const method of methods) {
      const envCredential = readEnvCredential(method.id);
      if (envCredential) {
        return {
          methodId: method.id,
          credential: envCredential,
          source: "env",
        };
      }

      const configCredential =
        configCredentials[method.id] ?? configCredentials[toEnvToken(method.id)];
      if (typeof configCredential === "string" && configCredential.trim().length > 0) {
        return {
          methodId: method.id,
          credential: configCredential,
          source: "config",
        };
      }
    }

    return undefined;
  }

  private async authenticateIfRequired(
    connection: ClientSideConnection,
    methods: AuthMethod[],
  ): Promise<void> {
    if (methods.length === 0) {
      return;
    }

    const selected = this.selectAuthMethod(methods);
    if (!selected) {
      if (this.options.authPolicy === "fail") {
        throw new AuthPolicyError(
          `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found`,
        );
      }

      this.log(
        `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`,
      );
      return;
    }

    await connection.authenticate({
      methodId: selected.methodId,
    });

    this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.cancellingSessionIds.has(params.sessionId)) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    let response: RequestPermissionResponse;
    try {
      response = await resolvePermissionRequest(
        params,
        this.options.permissionMode,
        this.options.nonInteractivePermissions ?? "deny",
      );
    } catch (error) {
      if (error instanceof PermissionPromptUnavailableError) {
        this.notePromptPermissionFailure(params.sessionId, error);
        this.recordPermissionDecision("cancelled");
        return {
          outcome: {
            outcome: "cancelled",
          },
        };
      }
      throw error;
    }

    const decision = classifyPermissionDecision(params, response);
    this.recordPermissionDecision(decision);

    return response;
  }

  private attachAgentLifecycleObservers(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): void {
    child.once("exit", (exitCode, signal) => {
      this.recordAgentExit("process_exit", exitCode, signal);
    });

    child.once("close", (exitCode, signal) => {
      this.recordAgentExit("process_close", exitCode, signal);
    });

    child.stdout.once("close", () => {
      this.recordAgentExit("pipe_close", child.exitCode ?? null, child.signalCode ?? null);
    });
  }

  private recordAgentExit(
    reason: AgentDisconnectReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.lastAgentExit) {
      return;
    }

    this.lastAgentExit = {
      exitCode,
      signal,
      exitedAt: isoNow(),
      reason,
      unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt),
    };
    this.rejectPendingConnectionRequests(
      new AgentDisconnectedError(reason, exitCode, signal, {
        outputAlreadyEmitted: Boolean(this.activePrompt),
      }),
    );
  }

  private notePromptPermissionFailure(
    sessionId: string,
    error: PermissionPromptUnavailableError,
  ): void {
    if (!this.promptPermissionFailures.has(sessionId)) {
      this.promptPermissionFailures.set(sessionId, error);
    }
  }

  private consumePromptPermissionFailure(
    sessionId: string,
  ): PermissionPromptUnavailableError | undefined {
    const error = this.promptPermissionFailures.get(sessionId);
    if (error) {
      this.promptPermissionFailures.delete(sessionId);
    }
    return error;
  }

  private async runConnectionRequest<T>(run: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const pending: PendingConnectionRequest = {
        settled: false,
        reject,
      };

      const finish = (cb: () => void) => {
        if (pending.settled) {
          return;
        }
        pending.settled = true;
        this.pendingConnectionRequests.delete(pending);
        cb();
      };

      this.pendingConnectionRequests.add(pending);
      void Promise.resolve()
        .then(run)
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  private rejectPendingConnectionRequests(error: unknown): void {
    for (const pending of this.pendingConnectionRequests) {
      if (pending.settled) {
        this.pendingConnectionRequests.delete(pending);
        continue;
      }
      pending.settled = true;
      this.pendingConnectionRequests.delete(pending);
      pending.reject(error);
    }
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      return await this.filesystem.readTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      return await this.filesystem.writeTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    try {
      return await this.terminalManager.createTerminal(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return await this.terminalManager.terminalOutput(params);
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return await this.terminalManager.waitForTerminalExit(params);
  }

  private async handleKillTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return await this.terminalManager.killTerminal(params);
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return await this.terminalManager.releaseTerminal(params);
  }

  private recordPermissionDecision(decision: "approved" | "denied" | "cancelled"): void {
    this.permissionStats.requested += 1;
    if (decision === "approved") {
      this.permissionStats.approved += 1;
      return;
    }
    if (decision === "denied") {
      this.permissionStats.denied += 1;
      return;
    }
    this.permissionStats.cancelled += 1;
  }

  private recordPermissionError(sessionId: string, error: unknown): void {
    if (error instanceof PermissionPromptUnavailableError) {
      this.notePromptPermissionFailure(sessionId, error);
      this.recordPermissionDecision("cancelled");
      return;
    }
    if (error instanceof PermissionDeniedError) {
      this.recordPermissionDecision("denied");
    }
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const sequence = ++this.observedSessionUpdates;
    this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
      try {
        if (!this.suppressSessionUpdates) {
          this.eventHandlers.onSessionUpdate?.(notification);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`session update handler failed: ${message}`);
      } finally {
        this.processedSessionUpdates = sequence;
      }
    });

    await this.sessionUpdateChain;
  }

  private async waitForSessionUpdateDrain(idleMs: number, timeoutMs: number): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    while (Date.now() <= deadline) {
      const observed = this.observedSessionUpdates;
      if (observed !== lastObserved) {
        lastObserved = observed;
        idleSince = Date.now();
      }

      if (
        this.processedSessionUpdates === this.observedSessionUpdates &&
        Date.now() - idleSince >= normalizedIdleMs
      ) {
        await this.sessionUpdateChain;
        if (this.processedSessionUpdates === this.observedSessionUpdates) {
          return;
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
      });
    }

    throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
  }
}
