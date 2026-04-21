import crypto from "node:crypto";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliStreamingDelta,
} from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  rawLines: string[];
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};
type ClaudeLiveSession = {
  key: string;
  fingerprint: string;
  managedRun: ManagedRun;
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: string;
  currentTurn: ClaudeLiveTurn | null;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupDone: boolean;
  closing: boolean;
};
type ClaudeLiveRunResult = {
  output: CliOutput;
};

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const liveSessions = new Map<string, ClaudeLiveSession>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
}

export function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.backendResolved.id === "claude-cli" &&
    context.preparedBackend.backend.liveSession === "claude-stdio" &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

function upsertArgValue(args: string[], flag: string, value: string): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === flag) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  normalized.push(flag, value);
  return normalized;
}

function appendArg(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function stripFreshSessionArgs(args: string[], backend: CliBackendConfig): string[] {
  const freshSessionFlags = new Set(
    [backend.sessionArg, "--session-id"].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    ),
  );
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (freshSessionFlags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...freshSessionFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function buildClaudeLiveArgs(args: string[], backend: CliBackendConfig): string[] {
  return appendArg(
    upsertArgValue(
      upsertArgValue(stripFreshSessionArgs(args, backend), "--input-format", "stream-json"),
      "--permission-prompt-tool",
      "stdio",
    ),
    "--replay-user-messages",
  );
}

function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return `${context.backendResolved.id}:${context.params.sessionId}`;
}

function buildClaudeLiveFingerprint(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
}): string {
  const normalizeMcpConfigPath = Boolean(params.context.preparedBackend.mcpConfigHash);
  const skillSnapshot = params.context.params.skillsSnapshot;
  const skillsFingerprint = skillSnapshot
    ? sha256(
        JSON.stringify({
          promptHash: sha256(skillSnapshot.prompt),
          skillFilter: skillSnapshot.skillFilter,
          skills: skillSnapshot.skills,
          resolvedSkills: (skillSnapshot.resolvedSkills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            sourceInfo: skill.sourceInfo,
          })),
          version: skillSnapshot.version,
        }),
      )
    : undefined;
  const normalizePluginDir = Boolean(skillsFingerprint);
  const unstableValueFlags = new Set(
    [
      params.context.preparedBackend.backend.sessionArg,
      "--session-id",
      "--resume",
      "-r",
      normalizeMcpConfigPath ? "--mcp-config" : undefined,
      normalizePluginDir ? "--plugin-dir" : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stableArgv: string[] = [];
  for (let i = 0; i < params.argv.length; i += 1) {
    const entry = params.argv[i] ?? "";
    if (unstableValueFlags.has(entry)) {
      stableArgv.push("<unstable>");
      i += 1;
      continue;
    }
    if ([...unstableValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      stableArgv.push("<unstable>");
      continue;
    }
    stableArgv.push(entry);
  }
  return JSON.stringify({
    command: params.context.preparedBackend.backend.command,
    workspaceDirHash: sha256(params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256(params.context.systemPrompt),
    authProfileIdHash: params.context.effectiveAuthProfileId
      ? sha256(params.context.effectiveAuthProfileId)
      : undefined,
    authEpochHash: params.context.authEpoch ? sha256(params.context.authEpoch) : undefined,
    extraSystemPromptHash: params.context.extraSystemPromptHash,
    mcpConfigHash: params.context.preparedBackend.mcpConfigHash,
    skillsFingerprint,
    argv: stableArgv,
    env: Object.keys(params.env)
      .toSorted()
      .filter((key) => key.startsWith("OPENCLAW_MCP_"))
      .map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""]),
  });
}

function createAbortError(): Error {
  const error = new Error("CLI run aborted");
  error.name = "AbortError";
  return error;
}

function clearTurnTimers(turn: ClaudeLiveTurn): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  session.currentTurn = null;
  turn.resolve(output);
  scheduleIdleClose(session);
}

function failTurn(session: ClaudeLiveSession, error: unknown): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  session.currentTurn = null;
  turn.reject(error);
}

function cleanupLiveSession(session: ClaudeLiveSession): void {
  if (session.cleanupDone) {
    return;
  }
  session.cleanupDone = true;
  void session.cleanup();
}

function closeLiveSession(
  session: ClaudeLiveSession,
  _reason: "idle" | "restart" | "abort",
  error?: unknown,
): void {
  if (session.closing) {
    return;
  }
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  if (error) {
    failTurn(session, error);
  }
  session.managedRun.cancel("manual-cancel");
  cleanupLiveSession(session);
}

function scheduleIdleClose(session: ClaudeLiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
    }
  }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
}

function createTimeoutError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
  });
}

function resetNoOutputTimer(session: ClaudeLiveSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      session,
      "abort",
      createTimeoutError(
        session,
        `CLI produced no output for ${Math.round(session.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, session.noOutputTimeoutMs);
}

function parseSessionId(parsed: Record<string, unknown>): string | undefined {
  const sessionId =
    typeof parsed.session_id === "string"
      ? parsed.session_id.trim()
      : typeof parsed.sessionId === "string"
        ? parsed.sessionId.trim()
        : "";
  return sessionId || undefined;
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  turn.rawLines.push(trimmed);
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
  if (parsed.type !== "result") {
    return;
  }
  finishTurn(
    session,
    parseCliOutput({
      raw: turn.rawLines.join("\n"),
      backend: turn.backend,
      providerId: session.providerId,
      outputMode: "jsonl",
      fallbackSessionId: turn.sessionId,
    }),
  );
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string) {
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  const lines = session.stdoutBuffer.split(/\r?\n/g);
  session.stdoutBuffer = lines.pop() ?? "";
  try {
    for (const line of lines) {
      handleClaudeLiveLine(session, line);
    }
  } catch (error) {
    closeLiveSession(session, "abort", error);
  }
}

function handleClaudeExit(session: ClaudeLiveSession, exitCode: number | null): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  cleanupLiveSession(session);
  if (!session.currentTurn) {
    return;
  }
  if (session.stdoutBuffer.trim()) {
    try {
      handleClaudeLiveLine(session, session.stdoutBuffer);
    } catch (error) {
      session.stdoutBuffer = "";
      closeLiveSession(session, "abort", error);
      return;
    }
    session.stdoutBuffer = "";
  }
  if (!session.currentTurn) {
    return;
  }
  const stderr = session.stderr.trim();
  const fallbackMessage =
    exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.";
  const message = extractCliErrorMessage(stderr) ?? (stderr || fallbackMessage);
  if (exitCode === 0) {
    failTurn(session, new Error(message));
    return;
  }
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
    }),
  );
}

function createClaudeUserInputMessage(content: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  })}\n`;
}

async function writeTurnInput(session: ClaudeLiveSession, prompt: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(createClaudeUserInputMessage(prompt), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createClaudeLiveSession(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
  fingerprint: string;
  key: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const managedRun = await params.supervisor.spawn({
    sessionId: params.context.params.sessionId,
    backendId: params.context.backendResolved.id,
    scopeKey: `claude-live:${params.key}`,
    replaceExistingScope: true,
    mode: "child",
    argv: params.argv,
    cwd: params.context.workspaceDir,
    env: params.env,
    stdinMode: "pipe-open",
    captureOutput: false,
    onStdout: (chunk) => {
      if (session) {
        handleClaudeStdout(session, chunk);
      }
    },
    onStderr: (chunk) => {
      if (session) {
        session.stderr += chunk;
        resetNoOutputTimer(session);
      }
    },
  });
  session = {
    key: params.key,
    fingerprint: params.fingerprint,
    managedRun,
    providerId: params.context.params.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: "",
    currentTurn: null,
    idleTimer: null,
    cleanup: params.cleanup,
    cleanupDone: false,
    closing: false,
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error) => {
      if (session) {
        cleanupLiveSession(session);
        failTurn(session, error);
      }
    },
  );
  liveSessions.set(params.key, session);
  return session;
}

function createTurn(params: {
  context: PreparedCliRunContext;
  noOutputTimeoutMs: number;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  session: ClaudeLiveSession;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const turn: ClaudeLiveTurn = {
    backend: params.context.preparedBackend.backend,
    rawLines: [],
    noOutputTimer: null,
    timeoutTimer: null,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.preparedBackend.backend,
      providerId: params.context.backendResolved.id,
      onAssistantDelta: params.onAssistantDelta,
    }),
    resolve: params.resolve,
    reject: params.reject,
  };
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI produced no output for ${Math.round(params.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, params.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI exceeded timeout (${Math.round(params.context.params.timeoutMs / 1000)}s) and was terminated.`,
      ),
    );
  }, params.context.params.timeoutMs);
  return turn;
}

export async function runClaudeLiveSessionTurn(params: {
  context: PreparedCliRunContext;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  const argv = [
    params.context.preparedBackend.backend.command,
    ...buildClaudeLiveArgs(params.args, params.context.preparedBackend.backend),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
  });
  let session = liveSessions.get(key) ?? null;
  if (session && session.fingerprint !== fingerprint) {
    closeLiveSession(session, "restart");
    session = null;
  }
  if (!session) {
    try {
      session = await createClaudeLiveSession({
        context: params.context,
        argv,
        env: params.env,
        fingerprint,
        key,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        supervisor: params.getProcessSupervisor(),
        cleanup: params.cleanup,
      });
    } catch (error) {
      await params.cleanup();
      throw error;
    }
  } else {
    await params.cleanup();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
  if (session.currentTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }
  const liveSession = session;
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    liveSession.currentTurn = createTurn({
      context: params.context,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      onAssistantDelta: params.onAssistantDelta,
      session: liveSession,
      resolve,
      reject,
    });
  });
  const abort = () => closeLiveSession(liveSession, "abort", createAbortError());
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.params.replyOperation
    ? {
        kind: "cli",
        cancel: abort,
        isStreaming: () => false,
      }
    : undefined;
  params.context.params.abortSignal?.addEventListener("abort", abort, { once: true });
  if (replyBackendHandle) {
    params.context.params.replyOperation?.attachBackend(replyBackendHandle);
  }
  try {
    if (params.context.params.abortSignal?.aborted) {
      abort();
    } else {
      try {
        await writeTurnInput(liveSession, params.prompt);
      } catch (error) {
        closeLiveSession(liveSession, "abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    if (replyBackendHandle) {
      params.context.params.replyOperation?.detachBackend(replyBackendHandle);
    }
  }
}
