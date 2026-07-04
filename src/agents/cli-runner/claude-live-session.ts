/**
 * Manages reusable Claude CLI stdio sessions for CLI-backed agent turns.
 */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAbortError as createNamedAbortError } from "../../infra/abort-signal.js";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.js";
import type { CliBackendConfig } from "../../config/types.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticToolParamsSummary,
  type DiagnosticToolSource,
  type DiagnosticToolExecutionErrorEvent,
  type DiagnosticToolExecutionCompletedEvent,
} from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  loadExecApprovals,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  resolveExecApprovalsFromFile,
  type ExecAsk,
  type ExecSecurity,
} from "../../infra/exec-approvals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import {
  CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliStreamJsonOutputLimits,
  type CliStreamingDelta,
  type CliToolResultDelta,
  type CliToolUseStartDelta,
  resolveCliStreamJsonOutputLimits,
} from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  registerNativeHookRelay,
  type NativeHookRelayRegistrationHandle,
} from "../harness/native-hook-relay.js";
import { findClaudeMcpConfigPath } from "./bundle-mcp-claude.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import { isClaudeLiveSessionTransport } from "./claude-live-contract.js";
import {
  resolveClaudeLiveMcpToolPolicy,
  type ClaudeLiveMcpToolPolicy,
} from "./claude-live-tool-policy.js";
import {
  CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS,
  prepareClaudeMcpPolicyProxy,
} from "./claude-mcp-policy-proxy.js";
import { buildClaudeOwnerKey } from "./helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<
  typeof import("../../process/supervisor/index.js").getProcessSupervisor
>;
type ManagedRun = Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  diagnosticRefs: ClaudeLiveDiagnosticRefs;
  outputLimits: ClaudeLiveOutputLimits;
  startedAtMs: number;
  rawLines: string[];
  rawChars: number;
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  activeToolTimer: NodeJS.Timeout | null;
  activeTools: Map<string, ClaudeLiveActiveTool>;
  observedStdout: boolean;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  execPermission: ClaudeLiveExecPermission;
  mcpToolPolicy: ClaudeLiveMcpToolPolicy;
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
  cleanupPromise: Promise<void> | null;
  closing: boolean;
  hookRelay?: NativeHookRelayRegistrationHandle;
  mcpCaptureKey?: string;
};
type ClaudeLiveRunResult = {
  output: CliOutput;
};
type ClaudeLiveOutputLimits = CliStreamJsonOutputLimits;
type ClaudeLiveExecPermission = {
  security: ExecSecurity;
  ask: ExecAsk;
  permissionMode: "bypassPermissions" | "default";
};
type ClaudeLiveDiagnosticRefs = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
};
type ClaudeLiveActiveTool = {
  toolName: string;
  toolCallId: string;
  startedAt: number;
};
type ClaudeLiveToolUse = {
  toolName: string;
  toolCallId: string;
  paramsSummary?: DiagnosticToolParamsSummary;
};

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_LIVE_ACTIVE_TOOL_PROGRESS_MS = 10_000;
const CLAUDE_LIVE_MAX_SESSIONS = 16;
const CLAUDE_LIVE_MAX_STDERR_CHARS = 64 * 1024;
const CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS = 5_000;
const CLAUDE_NATIVE_COMPUTER_USE_TOOL_GLOB = "mcp__computer-use__*";
const liveSessions = new Map<string, ClaudeLiveSession>();
const liveSessionCreates = new Map<string, Promise<ClaudeLiveSession>>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildClaudeLiveHookContext(context: PreparedCliRunContext): HookContext {
  const runParams = context.params;
  const channelId = runParams.messageChannel ?? runParams.messageProvider;
  const turnSourceTo = runParams.messageTo ?? runParams.currentChannelId;
  const turnSourceThreadId = runParams.messageThreadId ?? runParams.currentThreadTs;
  return {
    agentId: runParams.agentId ?? resolveAgentIdFromSessionKey(runParams.sessionKey),
    ...(runParams.config ? { config: runParams.config } : {}),
    cwd: context.cwd ?? context.workspaceDir,
    workspaceDir: context.workspaceDir,
    ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
    sessionId: runParams.sessionId,
    runId: runParams.runId,
    ...(channelId ? { channelId, turnSourceChannel: channelId } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(runParams.agentAccountId ? { turnSourceAccountId: runParams.agentAccountId } : {}),
    ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
    ...(runParams.skillsSnapshot ? { skillsSnapshot: runParams.skillsSnapshot } : {}),
  };
}

function buildClaudeMcpPolicyRelayDescriptor(key: string): {
  provider: "claude";
  relayId: string;
  generation: string;
} {
  const processKey = `${process.pid}:${key}`;
  return {
    provider: "claude",
    relayId: `claude-${process.pid}-${sha256(key).slice(0, 32)}`,
    generation: `claude-${sha256(processKey).slice(0, 32)}`,
  };
}

function registerClaudeMcpPolicyRelay(params: {
  context: PreparedCliRunContext;
  descriptor: ReturnType<typeof buildClaudeMcpPolicyRelayDescriptor>;
}): NativeHookRelayRegistrationHandle {
  const hookContext = buildClaudeLiveHookContext(params.context);
  return registerNativeHookRelay({
    ...params.descriptor,
    agentId: hookContext.agentId,
    sessionId: params.context.params.sessionId,
    sessionKey: params.context.params.sessionKey,
    config: params.context.params.config,
    hookContext,
    runId: params.context.params.runId,
    channelId: hookContext.channelId,
    allowedEvents: ["pre_tool_use", "post_tool_use"],
    ttlMs: params.context.params.timeoutMs + CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS,
    signal: params.context.params.abortSignal,
  });
}

/** Closes all live Claude CLI sessions and clears creation promises for tests. */
export function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
  liveSessionCreates.clear();
}

async function waitForManagedRunExit(managedRun: ManagedRun): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      managedRun.wait().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLAUDE_LIVE_CLOSE_WAIT_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Closes the live Claude session associated with a prepared run context, if one exists. */
export async function closeClaudeLiveSessionForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  const key = buildClaudeLiveKey(context);
  const session = liveSessions.get(key);
  if (session) {
    closeLiveSession(session, "restart");
    await waitForManagedRunExit(session.managedRun);
  }
  liveSessionCreates.delete(key);
}

/** Close a tainted live process so its replacement gets a fresh MCP capture key. */
export async function rotateClaudeLiveMcpCaptureKeyForContext(
  context: PreparedCliRunContext,
): Promise<void> {
  await closeClaudeLiveSessionForContext(context);
}

/** Returns whether a prepared backend context is eligible for Claude live stdio reuse. */
export function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean {
  return isClaudeLiveSessionTransport(context.preparedBackend.backend);
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

function appendVariadicArgValue(
  args: string[],
  flags: readonly string[],
  canonicalFlag: string,
  value: string,
): string[] {
  const values: string[] = [];
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const inlineFlag = flags.find((flag) => arg.startsWith(`${flag}=`));
    if (inlineFlag) {
      values.push(arg.slice(inlineFlag.length + 1));
      continue;
    }
    if (!flags.includes(arg)) {
      normalized.push(arg);
      continue;
    }
    while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
      values.push(args[i + 1] ?? "");
      i += 1;
    }
  }
  if (!values.includes(value)) {
    values.push(value);
  }
  return [...normalized, canonicalFlag, ...values];
}

function stripLiveProcessArgs(
  args: string[],
  backend: CliBackendConfig,
  stripSystemPrompt: boolean,
): string[] {
  const liveProcessFlags = new Set(
    [
      backend.sessionArg,
      "--session-id",
      stripSystemPrompt ? backend.systemPromptArg : undefined,
      stripSystemPrompt ? backend.systemPromptFileArg : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (liveProcessFlags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...liveProcessFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

/** Builds Claude CLI args for stream-json live sessions, stripping one-shot session flags. */
export function buildClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  systemPrompt: string;
  useResume: boolean;
  permissionMode?: string;
  denyNativeComputerUse?: boolean;
}): string[] {
  const processArgs = stripLiveProcessArgs(
    params.args,
    params.backend,
    params.useResume && params.backend.systemPromptWhen !== "always",
  );
  const liveArgs = appendArg(
    upsertArgValue(
      upsertArgValue(
        upsertArgValue(processArgs, "--input-format", "stream-json"),
        "--output-format",
        "stream-json",
      ),
      "--permission-prompt-tool",
      "stdio",
    ),
    "--replay-user-messages",
  );
  const restrictedArgs = params.denyNativeComputerUse
    ? appendVariadicArgValue(
        liveArgs,
        ["--disallowedTools", "--disallowed-tools"],
        "--disallowedTools",
        CLAUDE_NATIVE_COMPUTER_USE_TOOL_GLOB,
      )
    : liveArgs;
  // Live sessions always speak stream-json over stdin/stdout. Strip stale one-shot args above, then
  // force the live protocol flags so resume and non-resume turns share the same process contract.
  return params.permissionMode
    ? upsertArgValue(restrictedArgs, "--permission-mode", params.permissionMode)
    : restrictedArgs;
}

function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return `${context.backendResolved.id}:${buildClaudeOwnerKey({
    agentAccountId: context.params.agentAccountId,
    agentId: context.params.agentId,
    authProfileId: context.effectiveAuthProfileId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  })}`;
}

function buildClaudeLiveFingerprint(params: {
  context: PreparedCliRunContext;
  argv: string[];
  env: Record<string, string>;
  mcpToolPolicyFingerprint: string;
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
  const omittedValueFlags = new Set(
    [
      params.context.preparedBackend.backend.systemPromptArg,
      params.context.preparedBackend.backend.systemPromptFileArg,
      "--resume",
      "-r",
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const unstableValueFlags = new Set(
    [
      params.context.preparedBackend.backend.sessionArg,
      "--session-id",
      normalizeMcpConfigPath ? "--mcp-config" : undefined,
      normalizePluginDir ? "--plugin-dir" : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const stableArgv: string[] = [];
  for (let i = 0; i < params.argv.length; i += 1) {
    const entry = params.argv[i] ?? "";
    if (omittedValueFlags.has(entry)) {
      i += 1;
      continue;
    }
    if ([...omittedValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      continue;
    }
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
    cwdHash: params.context.cwdHash ?? sha256(params.context.cwd ?? params.context.workspaceDir),
    provider: params.context.params.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256(params.context.systemPrompt),
    authProfileIdHash: params.context.effectiveAuthProfileId
      ? sha256(params.context.effectiveAuthProfileId)
      : undefined,
    authEpochHash: params.context.authEpoch ? sha256(params.context.authEpoch) : undefined,
    extraSystemPromptHash: params.context.extraSystemPromptHash,
    promptToolNamesHash: params.context.promptToolNamesHash,
    mcpConfigHash: params.context.preparedBackend.mcpConfigHash,
    mcpToolPolicyFingerprint: params.mcpToolPolicyFingerprint,
    skillsFingerprint,
    argv: stableArgv,
    env: Object.keys(params.env)
      .toSorted()
      .map((key) => [key, params.env[key] ? sha256(params.env[key]) : ""]),
  });
}

function createAbortError(): Error {
  return createNamedAbortError("CLI run aborted");
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
  if (turn.activeToolTimer) {
    clearInterval(turn.activeToolTimer);
    turn.activeToolTimer = null;
  }
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  cliBackendLog.info(
    `claude live session turn: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} rawLines=${turn.rawLines.length} ${formatCliBackendOutputDigest(output.text)}`,
  );
  completeActiveClaudeLiveTools(turn);
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
  const errorKind = error instanceof Error ? error.name : typeof error;
  cliBackendLog.warn(
    `claude live session turn failed: provider=${session.providerId} model=${session.modelId} durationMs=${Date.now() - turn.startedAtMs} error=${errorKind}`,
  );
  failActiveClaudeLiveTools(turn, error);
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  session.currentTurn = null;
  turn.reject(error);
}

function abortTurn(session: ClaudeLiveSession, error: Error): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  closeLiveSession(session, "abort", error);
}

function cleanupLiveSession(session: ClaudeLiveSession): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = session.cleanup().catch((error: unknown) => {
      cliBackendLog.warn(`Claude live session cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
  return session.cleanupPromise;
}

function releaseClaudeLiveHookRelay(session: ClaudeLiveSession): void {
  session.hookRelay?.unregister();
  session.hookRelay = undefined;
}

function closeLiveSession(
  session: ClaudeLiveSession,
  reason: "idle" | "restart" | "abort",
  error?: unknown,
): void {
  if (session.closing) {
    return;
  }
  cliBackendLog.info(
    `claude live session close: provider=${session.providerId} model=${session.modelId} reason=${reason}`,
  );
  session.closing = true;
  releaseClaudeLiveHookRelay(session);
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
  void cleanupLiveSession(session);
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

function createTimeoutError(
  session: ClaudeLiveSession,
  message: string,
  code?: string,
): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
    code,
  });
}

function createOutputLimitError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "format",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("format"),
  });
}

function diagnosticToolSourceForClaudeLiveTool(toolName: string): DiagnosticToolSource {
  return toolName.startsWith("mcp__") ? "mcp" : "core";
}

function claudeLiveDiagnosticBase(turn: ClaudeLiveTurn) {
  return {
    runId: turn.diagnosticRefs.runId,
    sessionId: turn.diagnosticRefs.sessionId,
    ...(turn.diagnosticRefs.sessionKey ? { sessionKey: turn.diagnosticRefs.sessionKey } : {}),
  };
}

function emitClaudeLiveProgress(turn: ClaudeLiveTurn, reason: string): void {
  emitTrustedDiagnosticEvent({
    type: "run.progress",
    ...claudeLiveDiagnosticBase(turn),
    reason,
  });
}

function summarizeClaudeLiveToolInput(input: unknown): DiagnosticToolParamsSummary | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return { kind: "null" };
  }
  if (Array.isArray(input)) {
    return { kind: "array", length: input.length };
  }
  switch (typeof input) {
    case "object":
      return { kind: "object" };
    case "string":
      return { kind: "string", length: input.length };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "undefined":
      return { kind: "undefined" };
    default:
      return { kind: "other" };
  }
}

function readClaudeLiveMessageContent(parsed: Record<string, unknown>): unknown[] {
  const message = parsed.message;
  if (!isRecord(message)) {
    return [];
  }
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function readClaudeLiveToolUses(parsed: Record<string, unknown>): ClaudeLiveToolUse[] {
  const tools: ClaudeLiveToolUse[] = [];
  for (const entry of readClaudeLiveMessageContent(parsed)) {
    if (!isRecord(entry) || entry.type !== "tool_use") {
      continue;
    }
    const toolName = typeof entry.name === "string" ? entry.name.trim() : "";
    const toolCallId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!toolName || !toolCallId) {
      continue;
    }
    tools.push({
      toolName,
      toolCallId,
      paramsSummary: summarizeClaudeLiveToolInput(entry.input),
    });
  }
  return tools;
}

function readClaudeLiveToolResultIds(parsed: Record<string, unknown>): string[] {
  const toolResultIds: string[] = [];
  for (const entry of readClaudeLiveMessageContent(parsed)) {
    if (!isRecord(entry) || entry.type !== "tool_result") {
      continue;
    }
    const toolCallId = typeof entry.tool_use_id === "string" ? entry.tool_use_id.trim() : "";
    if (toolCallId) {
      toolResultIds.push(toolCallId);
    }
  }
  return toolResultIds;
}

function startClaudeLiveActiveToolHeartbeat(turn: ClaudeLiveTurn): void {
  if (turn.activeToolTimer || turn.activeTools.size === 0) {
    return;
  }
  turn.activeToolTimer = setInterval(() => {
    if (turn.activeTools.size === 0) {
      if (turn.activeToolTimer) {
        clearInterval(turn.activeToolTimer);
        turn.activeToolTimer = null;
      }
      return;
    }
    emitClaudeLiveProgress(turn, "cli_live:tool_running");
  }, CLAUDE_LIVE_ACTIVE_TOOL_PROGRESS_MS);
  turn.activeToolTimer.unref?.();
}

function stopClaudeLiveActiveToolHeartbeatIfIdle(turn: ClaudeLiveTurn): void {
  if (turn.activeTools.size > 0 || !turn.activeToolTimer) {
    return;
  }
  clearInterval(turn.activeToolTimer);
  turn.activeToolTimer = null;
}

function markClaudeLiveToolStarted(turn: ClaudeLiveTurn, tool: ClaudeLiveToolUse): void {
  const now = Date.now();
  turn.activeTools.set(tool.toolCallId, {
    toolName: tool.toolName,
    toolCallId: tool.toolCallId,
    startedAt: now,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...claudeLiveDiagnosticBase(turn),
    toolName: tool.toolName,
    toolSource: diagnosticToolSourceForClaudeLiveTool(tool.toolName),
    toolOwner: "claude-cli",
    toolCallId: tool.toolCallId,
    ...(tool.paramsSummary ? { paramsSummary: tool.paramsSummary } : {}),
  });
  emitClaudeLiveProgress(turn, "cli_live:tool_started");
  startClaudeLiveActiveToolHeartbeat(turn);
}

function markClaudeLiveToolCompleted(turn: ClaudeLiveTurn, toolCallId: string): void {
  const activeTool = turn.activeTools.get(toolCallId);
  if (!activeTool) {
    emitClaudeLiveProgress(turn, "cli_live:tool_result");
    return;
  }
  turn.activeTools.delete(toolCallId);
  const event: Omit<DiagnosticToolExecutionCompletedEvent, "seq" | "ts" | "type"> = {
    ...claudeLiveDiagnosticBase(turn),
    toolName: activeTool.toolName,
    toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
    toolOwner: "claude-cli",
    toolCallId: activeTool.toolCallId,
    durationMs: Math.max(0, Date.now() - activeTool.startedAt),
  };
  emitTrustedDiagnosticEvent({
    type: "tool.execution.completed",
    ...event,
  });
  emitClaudeLiveProgress(turn, "cli_live:tool_result");
  stopClaudeLiveActiveToolHeartbeatIfIdle(turn);
}

function completeActiveClaudeLiveTools(turn: ClaudeLiveTurn): void {
  const activeToolCallIds = Array.from(turn.activeTools.keys());
  for (const toolCallId of activeToolCallIds) {
    markClaudeLiveToolCompleted(turn, toolCallId);
  }
}

function failActiveClaudeLiveTools(turn: ClaudeLiveTurn, error: unknown): void {
  const errorCategory = error instanceof Error && error.name === "AbortError" ? "aborted" : "error";
  for (const activeTool of turn.activeTools.values()) {
    const event: Omit<DiagnosticToolExecutionErrorEvent, "seq" | "ts" | "type"> = {
      ...claudeLiveDiagnosticBase(turn),
      toolName: activeTool.toolName,
      toolSource: diagnosticToolSourceForClaudeLiveTool(activeTool.toolName),
      toolOwner: "claude-cli",
      toolCallId: activeTool.toolCallId,
      durationMs: Math.max(0, Date.now() - activeTool.startedAt),
      errorCategory,
    };
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...event,
    });
  }
  turn.activeTools.clear();
}

function noteClaudeLiveProgress(turn: ClaudeLiveTurn, parsed: Record<string, unknown>): void {
  const toolUses = readClaudeLiveToolUses(parsed);
  const toolResultIds = readClaudeLiveToolResultIds(parsed);
  for (const tool of toolUses) {
    markClaudeLiveToolStarted(turn, tool);
  }
  for (const toolCallId of toolResultIds) {
    markClaudeLiveToolCompleted(turn, toolCallId);
  }
  if (parsed.type === "result") {
    emitClaudeLiveProgress(turn, "cli_live:result");
    return;
  }
  if (toolUses.length > 0 || toolResultIds.length > 0) {
    return;
  }
  emitClaudeLiveProgress(turn, "cli_live:stream_progress");
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

function readConfiguredExecPolicy(context: PreparedCliRunContext): {
  security: ExecSecurity;
  ask: ExecAsk;
  agentId: string;
} {
  const agentId = context.params.agentId ?? resolveAgentIdFromSessionKey(context.params.sessionKey);
  const agentExec = context.params.config?.agents?.list?.find((agent) => agent.id === agentId)
    ?.tools?.exec;
  const exec = agentExec ?? context.params.config?.tools?.exec;
  const security = exec?.security ?? "full";
  const configuredAsk = exec?.ask ?? "off";
  const sessionAsk = normalizeExecAsk(context.params.sessionEntry?.execAsk);
  return {
    agentId,
    security,
    ask: sessionAsk ? maxAsk(configuredAsk, sessionAsk) : configuredAsk,
  };
}

function resolveClaudeLiveExecPermission(context: PreparedCliRunContext): ClaudeLiveExecPermission {
  const configured = readConfiguredExecPolicy(context);
  const approvals = resolveExecApprovalsFromFile({
    file: loadExecApprovals(),
    agentId: configured.agentId,
    overrides: {
      security: configured.security,
      ask: configured.ask,
    },
  });
  const security = minSecurity(configured.security, approvals.agent.security);
  const ask = maxAsk(configured.ask, approvals.agent.ask);
  return {
    security,
    ask,
    permissionMode: security === "full" && ask === "off" ? "bypassPermissions" : "default",
  };
}

function parseClaudeLiveJsonLine(
  session: ClaudeLiveSession,
  trimmed: string,
): Record<string, unknown> | null {
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (trimmed.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function createParsedOutputError(session: ClaudeLiveSession, output: CliOutput): FailoverError {
  const message = output.errorText || "Claude CLI failed.";
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  const code = reason === "context_overflow" ? "cli_context_overflow" : undefined;
  return new FailoverError(message, {
    reason,
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus(reason),
    code,
  });
}

function writeClaudeLiveControlResponse(session: ClaudeLiveSession, response: unknown): void {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  stdin.write(`${JSON.stringify(response)}\n`);
}

function writeClaudeLiveToolDecision(params: {
  session: ClaudeLiveSession;
  requestId: string;
  toolUseId?: string;
  decision:
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string };
}): void {
  writeClaudeLiveControlResponse(params.session, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: params.requestId,
      response:
        params.decision.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: params.decision.updatedInput,
              ...(params.toolUseId ? { toolUseID: params.toolUseId } : {}),
            }
          : {
              behavior: "deny",
              decisionClassification: "user_reject",
              message: params.decision.message,
              ...(params.toolUseId ? { toolUseID: params.toolUseId } : {}),
            },
    },
  });
}

function handleClaudeLiveControlRequest(
  session: ClaudeLiveSession,
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
): void {
  if (parsed.type !== "control_request" || !isRecord(parsed.request)) {
    return;
  }
  const request = parsed.request;
  if (request.subtype !== "can_use_tool") {
    return;
  }
  const requestId = typeof parsed.request_id === "string" ? parsed.request_id : "";
  if (!requestId) {
    return;
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const toolName = typeof request.tool_name === "string" ? request.tool_name.trim() : "";
  const toolInput = isRecord(request.input) ? request.input : {};
  const mcpDecision = toolName ? turn.mcpToolPolicy.decide(toolName) : { matched: false as const };
  if (mcpDecision.matched) {
    if (!mcpDecision.allowed) {
      writeClaudeLiveToolDecision({
        session,
        requestId,
        toolUseId,
        decision: { behavior: "deny", message: mcpDecision.reason },
      });
      return;
    }
    writeClaudeLiveToolDecision({
      session,
      requestId,
      toolUseId,
      decision: { behavior: "allow", updatedInput: toolInput },
    });
    return;
  }
  const allowed = turn.execPermission.security === "full" && turn.execPermission.ask === "off";
  writeClaudeLiveToolDecision({
    session,
    requestId,
    toolUseId,
    decision: allowed
      ? { behavior: "allow", updatedInput: toolInput }
      : {
          behavior: "deny",
          message: `OpenClaw exec policy denied Claude native tool use (security=${turn.execPermission.security}, ask=${turn.execPermission.ask}).`,
        },
  });
}

function assertNoNativeClaudeComputerUse(
  turn: ClaudeLiveTurn,
  parsed: Record<string, unknown>,
): void {
  if (
    !turn.mcpToolPolicy.hasComputerUseProxy ||
    parsed.type !== "system" ||
    parsed.subtype !== "init"
  ) {
    return;
  }
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  if (tools.some((tool) => tool.startsWith("mcp__computer-use__"))) {
    throw new Error("Claude CLI exposed native computer-use tools despite the OpenClaw deny rule.");
  }
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const parsed = parseClaudeLiveJsonLine(session, trimmed);
  if (turn) {
    turn.observedStdout = true;
  }
  if (!parsed) {
    return;
  }
  if (!turn) {
    return;
  }
  assertNoNativeClaudeComputerUse(turn, parsed);
  turn.rawChars += trimmed.length + 1;
  if (
    turn.rawChars > turn.outputLimits.maxTurnRawChars ||
    turn.rawLines.length >= turn.outputLimits.maxTurnLines
  ) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI turn output exceeded limit."),
    );
    return;
  }
  turn.rawLines.push(trimmed);
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
  noteClaudeLiveProgress(turn, parsed);
  handleClaudeLiveControlRequest(session, turn, parsed);
  if (parsed.type !== "result") {
    return;
  }
  const raw = turn.rawLines.join("\n");
  const output = parseCliOutput({
    raw,
    backend: turn.backend,
    providerId: session.providerId,
    outputMode: "jsonl",
    fallbackSessionId: turn.sessionId,
  });
  if (output.errorText) {
    failTurn(session, createParsedOutputError(session, output));
    scheduleIdleClose(session);
    return;
  }
  finishTurn(session, output);
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string) {
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  const maxPendingLineChars =
    session.currentTurn?.outputLimits.maxPendingLineChars ??
    CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS;
  if (session.stdoutBuffer.length > maxPendingLineChars) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return;
  }
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
  session.closing = true;
  releaseClaudeLiveHookRelay(session);
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  void cleanupLiveSession(session);
  if (!session.currentTurn) {
    return;
  }
  if (session.stdoutBuffer.trim()) {
    try {
      handleClaudeLiveLine(session, session.stdoutBuffer);
    } catch (error) {
      session.stdoutBuffer = "";
      failTurn(session, error);
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
  if (exitCode === 0 && !stderr) {
    const turn = session.currentTurn;
    const retryCode =
      turn && !turn.observedStdout && turn.rawLines.length === 0
        ? "cli_unknown_empty_failure"
        : undefined;
    failTurn(
      session,
      new FailoverError(message, {
        reason: "empty_response",
        provider: session.providerId,
        model: session.modelId,
        status: resolveFailoverStatus("empty_response"),
        code: retryCode,
      }),
    );
    return;
  }
  const reason = classifyFailoverReason(message, { provider: session.providerId }) ?? "unknown";
  const code = reason === "context_overflow" ? "cli_context_overflow" : undefined;
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
      code,
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
  mcpCaptureKey?: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
  hookRelay?: NativeHookRelayRegistrationHandle;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const mcpCaptureAttempt = await prepareCliBundleMcpCaptureAttempt({
    mode: params.context.backendResolved.bundleMcpMode,
    backend: params.context.preparedBackend.backend,
    env: params.env,
    captureKey: params.mcpCaptureKey,
  });
  let managedRun: ManagedRun;
  try {
    managedRun = await params.supervisor.spawn({
      sessionId: params.context.params.sessionId,
      backendId: params.context.backendResolved.id,
      scopeKey: `claude-live:${params.key}`,
      replaceExistingScope: true,
      mode: "child",
      argv: params.argv,
      cwd: params.context.cwd ?? params.context.workspaceDir,
      env: mcpCaptureAttempt.env ?? params.env,
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
          if (session.stderr.length > CLAUDE_LIVE_MAX_STDERR_CHARS) {
            closeLiveSession(
              session,
              "abort",
              createOutputLimitError(session, "Claude CLI stderr exceeded limit."),
            );
            return;
          }
          resetNoOutputTimer(session);
        }
      },
    });
  } catch (error) {
    await mcpCaptureAttempt.cleanup?.();
    throw error;
  }
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
    cleanup: async () => {
      await mcpCaptureAttempt.cleanup?.();
      await params.cleanup();
    },
    cleanupPromise: null,
    closing: false,
    hookRelay: params.hookRelay,
    mcpCaptureKey: params.mcpCaptureKey,
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error: unknown) => {
      if (session) {
        closeLiveSession(session, "abort", error);
      }
    },
  );
  liveSessions.set(params.key, session);
  cliBackendLog.info(
    `claude live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`,
  );
  return session;
}

function createTurn(params: {
  context: PreparedCliRunContext;
  noOutputTimeoutMs: number;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  session: ClaudeLiveSession;
  execPermission: ClaudeLiveExecPermission;
  mcpToolPolicy: ClaudeLiveMcpToolPolicy;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  // The liveSession contract owns the wire dialect. Custom backend ids must
  // not fall back to generic JSONL parsing after opting into Claude stdio.
  const backend = {
    ...params.context.preparedBackend.backend,
    jsonlDialect: "claude-stream-json" as const,
  };
  const turn: ClaudeLiveTurn = {
    backend,
    diagnosticRefs: {
      runId: params.context.params.runId,
      sessionId: params.context.params.sessionId,
      ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
    },
    outputLimits: resolveCliStreamJsonOutputLimits(backend),
    startedAtMs: Date.now(),
    rawLines: [],
    rawChars: 0,
    noOutputTimer: null,
    timeoutTimer: null,
    activeToolTimer: null,
    activeTools: new Map(),
    observedStdout: false,
    streamingParser: createCliJsonlStreamingParser({
      backend,
      providerId: params.context.backendResolved.id,
      onAssistantDelta: params.onAssistantDelta,
      onToolUseStart: params.onToolUseStart,
      onToolResult: params.onToolResult,
      onCommentaryText: params.onCommentaryText,
    }),
    execPermission: params.execPermission,
    mcpToolPolicy: params.mcpToolPolicy,
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
        "cli_no_output_timeout",
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

function closeOldestIdleSession(): boolean {
  for (const session of liveSessions.values()) {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
      return true;
    }
  }
  return false;
}

function ensureLiveSessionCapacity(key: string, context: PreparedCliRunContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < CLAUDE_LIVE_MAX_SESSIONS
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many Claude CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.params.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

/** Runs one prompt through a reusable Claude CLI live session. */
export async function runClaudeLiveSessionTurn(params: {
  context: PreparedCliRunContext;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  onToolUseStart?: (delta: CliToolUseStartDelta) => void;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onCommentaryText?: (text: string) => void;
  onMcpCaptureReady?: (captureKey: string) => void;
  onCleanupOwnershipTransferred?: () => void;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult> {
  const key = buildClaudeLiveKey(params.context);
  const resumeCapable = Boolean(params.context.preparedBackend.backend.resumeArgs?.length);
  const execPermission = resolveClaudeLiveExecPermission(params.context);
  const mcpToolPolicy = resolveClaudeLiveMcpToolPolicy(params.context);
  const relayDescriptor = mcpToolPolicy.hasExternalServers
    ? buildClaudeMcpPolicyRelayDescriptor(key)
    : undefined;
  if (mcpToolPolicy.hasExternalServers) {
    const mcpConfigPath = findClaudeMcpConfigPath(params.args);
    if (!mcpConfigPath) {
      throw new Error("Claude MCP policy proxy requires the generated strict MCP config");
    }
    await prepareClaudeMcpPolicyProxy({
      mcpConfigPath,
      servers: mcpToolPolicy.proxyServers,
      env: params.env,
      relay: relayDescriptor!,
    });
  }
  const permissionMode = mcpToolPolicy.hasExternalServers
    ? "default"
    : execPermission.permissionMode;
  const argv = [
    params.context.preparedBackend.backend.command,
    ...buildClaudeLiveArgs({
      args: params.args,
      backend: params.context.preparedBackend.backend,
      systemPrompt: params.context.systemPrompt,
      useResume: params.useResume,
      permissionMode,
      denyNativeComputerUse: mcpToolPolicy.hasComputerUseProxy,
    }),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
    mcpToolPolicyFingerprint: mcpToolPolicy.fingerprint,
  });
  let cleanupDone = false;
  let hookRelay: NativeHookRelayRegistrationHandle | undefined;
  const ensureHookRelay = (): NativeHookRelayRegistrationHandle | undefined => {
    if (!relayDescriptor) {
      return undefined;
    }
    hookRelay ??= registerClaudeMcpPolicyRelay({
      context: params.context,
      descriptor: relayDescriptor,
    });
    return hookRelay;
  };
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await params.cleanup();
  };
  let session = liveSessions.get(key) ?? null;
  if (session && resumeCapable && !params.useResume) {
    // Non-resume turns must start from a fresh process when the backend supports resume; otherwise
    // Claude could inherit conversation state from the previous live turn.
    closeLiveSession(session, "restart");
    session = null;
  }
  if (session && session.fingerprint !== fingerprint) {
    closeLiveSession(session, "restart");
    session = null;
  }
  let cleanupTurnArtifacts = Boolean(session);
  try {
    ensureLiveSessionCapacity(key, params.context);
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (!session) {
    const pendingSession = liveSessionCreates.get(key);
    if (pendingSession) {
      try {
        session = await pendingSession;
      } catch (error) {
        await cleanup();
        throw error;
      }
      if (session.fingerprint !== fingerprint) {
        closeLiveSession(session, "restart");
        session = null;
      } else if (resumeCapable && !params.useResume) {
        closeLiveSession(session, "restart");
        session = null;
      } else {
        cleanupTurnArtifacts = true;
      }
    }
    if (!session) {
      const sessionHookRelay = ensureHookRelay();
      const createSession = createClaudeLiveSession({
        context: params.context,
        argv,
        env: params.env,
        fingerprint,
        key,
        mcpCaptureKey: params.context.mcpDeliveryCapture ? crypto.randomUUID() : undefined,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        supervisor: params.getProcessSupervisor(),
        cleanup,
        hookRelay: sessionHookRelay,
      }).finally(() => {
        if (liveSessionCreates.get(key) === createSession) {
          liveSessionCreates.delete(key);
        }
      });
      liveSessionCreates.set(key, createSession);
      try {
        session = await createSession;
      } catch (error) {
        sessionHookRelay?.unregister();
        await cleanup();
        throw error;
      }
    }
  }
  const currentHookRelay = ensureHookRelay();
  if (currentHookRelay) {
    session.hookRelay = currentHookRelay;
  }
  if (cleanupTurnArtifacts && session) {
    await cleanup();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    cliBackendLog.info(
      `claude live session reuse: provider=${session.providerId} model=${session.modelId}`,
    );
  }
  params.onCleanupOwnershipTransferred?.();
  if (session.closing) {
    await cleanup();
    throw new Error("Claude CLI live session closed before handling the turn");
  }
  if (session.currentTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }
  const liveSession = session;
  if (liveSession.mcpCaptureKey) {
    params.onMcpCaptureReady?.(liveSession.mcpCaptureKey);
  }
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    liveSession.currentTurn = createTurn({
      context: params.context,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      onAssistantDelta: params.onAssistantDelta,
      onToolUseStart: params.onToolUseStart,
      onToolResult: params.onToolResult,
      onCommentaryText: params.onCommentaryText,
      session: liveSession,
      execPermission,
      mcpToolPolicy,
      resolve,
      reject,
    });
  });
  // Timeout/abort can reject the turn while stdin is backpressured. Keep the
  // rejection handled until the final await below rethrows the canonical result.
  void outputPromise.catch(() => undefined);
  const abort = () => abortTurn(liveSession, createAbortError());
  let replyBackendCompleted = false;
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.params.replyOperation
    ? {
        kind: "cli",
        cancel: abort,
        isStreaming: () => !replyBackendCompleted,
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
        await Promise.race([writeTurnInput(liveSession, params.prompt), outputPromise]);
      } catch (error) {
        closeLiveSession(liveSession, "abort", error);
      }
    }
    return { output: await outputPromise };
  } finally {
    replyBackendCompleted = true;
    params.context.params.abortSignal?.removeEventListener("abort", abort);
    try {
      if (replyBackendHandle) {
        params.context.params.replyOperation?.detachBackend(replyBackendHandle);
      }
    } finally {
      if (liveSession.mcpCaptureKey) {
        // The capture key is process environment, so a captured turn must end its
        // process before the attempt releases that key to avoid cross-turn sends.
        closeLiveSession(liveSession, "restart");
        await waitForManagedRunExit(liveSession.managedRun);
        await cleanupLiveSession(liveSession);
      }
    }
  }
}
