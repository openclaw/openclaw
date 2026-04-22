import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../infra/errors.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

type SessionBranchEntry = ReturnType<ReturnType<typeof SessionManager.open>["getBranch"]>[number];
type SessionContextMessage = {
  role?: string;
  content?: unknown;
};
type ClaudeSeedMetadata = {
  cwd: string;
  version: string;
  gitBranch: string;
  entrypoint?: string;
  userType?: string;
  permissionMode?: string;
};
type SettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};

const defaultCliRunnerDeps = {
  openSessionManager: (sessionFile: string) => SessionManager.open(sessionFile),
  accessSessionFile: async (sessionFile: string) =>
    await fs
      .access(sessionFile)
      .then(() => true)
      .catch(() => false),
  prepareSessionManagerForRun: async (
    params: Parameters<
      typeof import("./pi-embedded-runner/session-manager-init.js").prepareSessionManagerForRun
    >[0],
  ) =>
    (await import("./pi-embedded-runner/session-manager-init.js")).prepareSessionManagerForRun(
      params,
    ),
  resolveContextEngine: async (cfg: NonNullable<RunCliAgentParams["config"]>) =>
    (await import("../context-engine/registry.js")).resolveContextEngine(cfg),
  createPreparedEmbeddedPiSettingsManager: async (params: {
    cwd: string;
    agentDir: string;
    cfg?: RunCliAgentParams["config"];
    contextTokenBudget?: number;
  }) => (await import("./pi-project-settings.js")).createPreparedEmbeddedPiSettingsManager(params),
  applyPiAutoCompactionGuard: async (params: {
    settingsManager: SettingsManagerLike;
    contextEngineInfo?: Awaited<
      ReturnType<typeof import("../context-engine/registry.js").resolveContextEngine>
    >["info"];
  }) => (await import("./pi-settings.js")).applyPiAutoCompactionGuard(params),
  shouldPreemptivelyCompactBeforePrompt: async (
    params: Parameters<
      typeof import("./pi-embedded-runner/run/preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt
    >[0],
  ) =>
    (
      await import("./pi-embedded-runner/run/preemptive-compaction.js")
    ).shouldPreemptivelyCompactBeforePrompt(params),
  runContextEngineMaintenance: async (
    params: Parameters<
      typeof import("./pi-embedded-runner/context-engine-maintenance.js").runContextEngineMaintenance
    >[0],
  ) =>
    (
      await import("./pi-embedded-runner/context-engine-maintenance.js")
    ).runContextEngineMaintenance(params),
  resolveLiveToolResultMaxChars: async (params: {
    contextWindowTokens: number;
    cfg?: RunCliAgentParams["config"];
    agentId?: string;
  }) =>
    (await import("./pi-embedded-runner/tool-result-truncation.js")).resolveLiveToolResultMaxChars(
      params,
    ),
  realpath: async (targetPath: string) => await fs.realpath(targetPath),
  mkdir: async (dirPath: string) => await fs.mkdir(dirPath, { recursive: true, mode: 0o700 }),
  writeFile: async (filePath: string, content: string) =>
    await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
  readFile: async (filePath: string) => await fs.readFile(filePath, "utf-8"),
};
const cliRunnerDeps = { ...defaultCliRunnerDeps };

export function setCliRunnerCompactionTestDeps(overrides: Partial<typeof cliRunnerDeps>): void {
  Object.assign(cliRunnerDeps, overrides);
}

export function resetCliRunnerCompactionTestDeps(): void {
  Object.assign(cliRunnerDeps, defaultCliRunnerDeps);
}

function getSessionBranchMessages(
  sessionManager: ReturnType<typeof SessionManager.open>,
): AgentMessage[] {
  const branch = sessionManager.getBranch();
  return branch
    .filter((entry): entry is SessionBranchEntry & { type: "message"; message: AgentMessage } => {
      return (
        entry.type === "message" && typeof entry.message === "object" && entry.message !== null
      );
    })
    .map((entry) => entry.message);
}

function coerceMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function buildCliHistoryReseedPrompt(params: {
  messages: SessionContextMessage[];
  prompt: string;
}): string {
  const renderedHistory = params.messages
    .flatMap((message) => {
      const role =
        message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "";
      if (!role) {
        return [];
      }
      const text = coerceMessageText(message.content);
      return text ? [`${role}: ${text}`] : [];
    })
    .join("\n\n")
    .trim();

  if (!renderedHistory) {
    return params.prompt;
  }

  return [
    "Continue this conversation using the compacted transcript below as the prior session history.",
    "Treat it as authoritative context for this fresh session.",
    "",
    "<conversation_history>",
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

function isClaudeCliProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

/**
 * Encode a workspace path into the directory name Claude Code uses to store
 * its per-project session JSONL files under `~/.claude/projects/<encoded>/`.
 *
 * Observed in Claude Code CLI v2.1.x (captured against v2.1.114 as of 2026-04):
 * every character that is not `[A-Za-z0-9]` is replaced with a single `-`, with
 * no collapsing of consecutive replacements and no length limit. This mirrors
 * the behavior seen across macOS and Linux installs.
 *
 * Because this mirrors an undocumented CLI implementation detail, it can drift
 * when Claude Code changes its session storage layout. If session-continuity on
 * the `claude-cli` rotation path starts silently falling back to a prompt
 * reseed, re-observe the real directory name Claude CLI writes for the same
 * workspace (for example, `ls ~/.claude/projects/`) and update this helper —
 * then bump the version note above and `readClaudeSeedMetadata` covers the
 * on-disk format expectations.
 */
export function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Claude CLI session ids are UUIDs. We validate before interpolating into
 * `~/.claude/projects/<dir>/<sessionId>.jsonl` so a malformed or attacker-
 * influenced id can never escape that directory via `/`, `..`, or other path
 * metacharacters. Accept only canonical UUIDs (case-insensitive) to keep the
 * check tight; any non-UUID input is treated as "no reusable session".
 */
const CLAUDE_CLI_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafeClaudeCliSessionId(value: string): boolean {
  return CLAUDE_CLI_SESSION_ID_PATTERN.test(value);
}

function buildClaudeSeededSessionEntries(params: {
  sessionId: string;
  messages: SessionContextMessage[];
  metadata: ClaudeSeedMetadata;
  modelId: string;
}): string {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  let timestampMs = Date.now();

  for (const message of params.messages) {
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
    if (!role) {
      continue;
    }
    const text = coerceMessageText(message.content);
    if (!text) {
      continue;
    }
    const uuid = randomUUID();
    const baseEntry = {
      parentUuid,
      isSidechain: false,
      userType: params.metadata.userType ?? "external",
      entrypoint: params.metadata.entrypoint ?? "sdk-cli",
      cwd: params.metadata.cwd,
      sessionId: params.sessionId,
      version: params.metadata.version,
      gitBranch: params.metadata.gitBranch,
      uuid,
      timestamp: new Date(timestampMs).toISOString(),
    };
    if (role === "user") {
      lines.push(
        JSON.stringify({
          ...baseEntry,
          promptId: randomUUID(),
          type: "user",
          message: {
            role: "user",
            content: text,
          },
          permissionMode: params.metadata.permissionMode ?? "bypassPermissions",
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          ...baseEntry,
          type: "assistant",
          requestId: `req_seed_${uuid.slice(0, 12)}`,
          message: {
            id: `msg_seed_${uuid.slice(0, 12)}`,
            type: "message",
            role: "assistant",
            model: params.modelId,
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        }),
      );
    }
    parentUuid = uuid;
    timestampMs += 1;
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

async function readClaudeSeedMetadata(params: {
  workspaceDir: string;
  existingSessionId?: string;
}): Promise<ClaudeSeedMetadata> {
  const resolvedWorkspace = await cliRunnerDeps
    .realpath(params.workspaceDir)
    .catch(() => params.workspaceDir);
  const defaultMetadata: ClaudeSeedMetadata = {
    cwd: resolvedWorkspace,
    version: "2.1.114",
    gitBranch: "HEAD",
    entrypoint: "sdk-cli",
    userType: "external",
    permissionMode: "bypassPermissions",
  };
  const sessionId = params.existingSessionId?.trim();
  if (!sessionId || !isSafeClaudeCliSessionId(sessionId)) {
    return defaultMetadata;
  }

  const sessionFile = `${process.env.HOME ?? ""}/.claude/projects/${encodeClaudeProjectPath(resolvedWorkspace)}/${sessionId}.jsonl`;
  const raw = await cliRunnerDeps.readFile(sessionFile).catch(() => "");
  if (!raw) {
    return defaultMetadata;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.sessionId !== "string" || parsed.sessionId !== sessionId) {
        continue;
      }
      if (typeof parsed.cwd !== "string" || typeof parsed.version !== "string") {
        continue;
      }
      return {
        cwd: parsed.cwd,
        version: parsed.version,
        gitBranch:
          typeof parsed.gitBranch === "string" ? parsed.gitBranch : defaultMetadata.gitBranch,
        entrypoint:
          typeof parsed.entrypoint === "string" ? parsed.entrypoint : defaultMetadata.entrypoint,
        userType: typeof parsed.userType === "string" ? parsed.userType : defaultMetadata.userType,
        permissionMode:
          typeof parsed.permissionMode === "string"
            ? parsed.permissionMode
            : defaultMetadata.permissionMode,
      };
    } catch {
      continue;
    }
  }
  return defaultMetadata;
}

async function createClaudeSeededSession(params: {
  workspaceDir: string;
  existingSessionId?: string;
  messages: SessionContextMessage[];
  modelId: string;
}): Promise<string | undefined> {
  const metadata = await readClaudeSeedMetadata({
    workspaceDir: params.workspaceDir,
    existingSessionId: params.existingSessionId,
  });
  const sessionId = randomUUID();
  const projectDir = `${process.env.HOME ?? ""}/.claude/projects/${encodeClaudeProjectPath(metadata.cwd)}`;
  const sessionFile = `${projectDir}/${sessionId}.jsonl`;
  const content = buildClaudeSeededSessionEntries({
    sessionId,
    messages: params.messages,
    metadata,
    modelId: params.modelId,
  });
  if (!content.trim()) {
    return undefined;
  }
  await cliRunnerDeps.mkdir(projectDir);
  await cliRunnerDeps.writeFile(sessionFile, content);
  return sessionId;
}

async function runCliPreTurnCompactionMaintenance(context: PreparedCliRunContext): Promise<void> {
  const { params } = context;
  const contextTokenBudget =
    typeof context.contextTokenBudget === "number" && Number.isFinite(context.contextTokenBudget)
      ? Math.floor(context.contextTokenBudget)
      : undefined;
  if (!params.config || !context.agentDir || !contextTokenBudget || contextTokenBudget <= 0) {
    return;
  }

  const contextEngine = await cliRunnerDeps.resolveContextEngine(params.config);
  if (contextEngine.info.ownsCompaction === true) {
    return;
  }

  const hadSessionFile = await cliRunnerDeps.accessSessionFile(params.sessionFile);
  const sessionManager = cliRunnerDeps.openSessionManager(params.sessionFile);
  await cliRunnerDeps.prepareSessionManagerForRun({
    sessionManager,
    sessionFile: params.sessionFile,
    hadSessionFile,
    sessionId: params.sessionId,
    cwd: context.workspaceDir,
  });

  const settingsManager = await cliRunnerDeps.createPreparedEmbeddedPiSettingsManager({
    cwd: context.workspaceDir,
    agentDir: context.agentDir,
    cfg: params.config,
    contextTokenBudget,
  });
  await cliRunnerDeps.applyPiAutoCompactionGuard({
    settingsManager,
    contextEngineInfo: contextEngine.info,
  });

  const reserveTokens = settingsManager.getCompactionReserveTokens();
  const preemptiveCompaction = await cliRunnerDeps.shouldPreemptivelyCompactBeforePrompt({
    messages: getSessionBranchMessages(sessionManager),
    systemPrompt: context.systemPrompt,
    prompt: params.prompt,
    contextTokenBudget,
    reserveTokens,
    toolResultMaxChars: await cliRunnerDeps.resolveLiveToolResultMaxChars({
      contextWindowTokens: contextTokenBudget,
      cfg: params.config,
      agentId: params.agentId,
    }),
  });

  if (!preemptiveCompaction.shouldCompact) {
    return;
  }

  const maintenanceResult = await cliRunnerDeps.runContextEngineMaintenance({
    contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionManager,
    reason: "compaction",
    runtimeContext: {
      tokenBudget: contextTokenBudget,
      currentTokenCount: preemptiveCompaction.estimatedPromptTokens,
    },
  });

  if (!maintenanceResult?.changed) {
    return;
  }

  const sessionContext = sessionManager.buildSessionContext();
  const reseedMessages = Array.isArray(sessionContext.messages)
    ? (sessionContext.messages as SessionContextMessage[])
    : [];
  if (isClaudeCliProvider(params.provider)) {
    const seededSessionId = await createClaudeSeededSession({
      workspaceDir: context.workspaceDir,
      existingSessionId: context.reusableCliSession.sessionId,
      messages: reseedMessages,
      modelId: context.normalizedModel,
    }).catch(() => undefined);
    if (seededSessionId) {
      context.reseedPrompt = undefined;
      context.forceFreshSession = false;
      context.reusableCliSession = { sessionId: seededSessionId };
      await params.onResetReusableCliSession?.();
      return;
    }
  }

  context.reseedPrompt = buildCliHistoryReseedPrompt({
    messages: reseedMessages,
    prompt: params.prompt,
  });
  context.forceFreshSession = true;
  context.reusableCliSession = {};
  await params.onResetReusableCliSession?.();
}

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
  const context = await prepareCliRunContext(params);
  return runPreparedCliAgent(context);
}

export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
): Promise<EmbeddedPiRunResult> {
  const { executePreparedCliRun } = await import("./cli-runner/execute.runtime.js");
  const { params } = context;
  const buildCliRunResult = (resultParams: {
    output: Awaited<ReturnType<typeof executePreparedCliRun>>;
    effectiveCliSessionId?: string;
  }): EmbeddedPiRunResult => {
    const text = resultParams.output.text?.trim();
    const rawText = resultParams.output.rawText?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - context.started,
        ...(resultParams.output.finalPromptText
          ? { finalPromptText: resultParams.output.finalPromptText }
          : {}),
        ...(text || rawText
          ? {
              ...(text ? { finalAssistantVisibleText: text } : {}),
              ...(rawText ? { finalAssistantRawText: rawText } : {}),
            }
          : {}),
        systemPromptReport: context.systemPromptReport,
        executionTrace: {
          winnerProvider: params.provider,
          winnerModel: context.modelId,
          attempts: [
            {
              provider: params.provider,
              model: context.modelId,
              result: "success",
            },
          ],
          fallbackUsed: false,
          runner: "cli",
        },
        requestShaping: {
          ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
          ...(params.authProfileId ? { authMode: "auth-profile" } : {}),
        },
        completion: {
          finishReason: "stop",
          stopReason: "completed",
          refusal: false,
        },
        agentMeta: {
          sessionId: resultParams.effectiveCliSessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: context.modelId,
          usage: resultParams.output.usage,
          ...(resultParams.effectiveCliSessionId
            ? {
                cliSessionBinding: {
                  sessionId: resultParams.effectiveCliSessionId,
                  ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                  ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                  ...(context.extraSystemPromptHash
                    ? { extraSystemPromptHash: context.extraSystemPromptHash }
                    : {}),
                  ...(context.preparedBackend.mcpConfigHash
                    ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                    : {}),
                },
              }
            : {}),
        },
      },
    };
  };

  // Try with the provided CLI session ID first
  try {
    await runCliPreTurnCompactionMaintenance(context);
    try {
      const output = await executePreparedCliRun(
        context,
        context.forceFreshSession ? undefined : context.reusableCliSession.sessionId,
      );
      const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
      return buildCliRunResult({ output, effectiveCliSessionId });
    } catch (err) {
      if (isFailoverError(err)) {
        const retryableSessionId = context.reusableCliSession.sessionId ?? params.cliSessionId;
        // Check if this is a session expired error and we have a session to clear
        if (err.reason === "session_expired" && retryableSessionId && params.sessionKey) {
          // Clear the expired session ID from the session entry
          // This requires access to the session store, which we don't have here
          // We'll need to modify the caller to handle this case

          // For now, retry without the session ID to create a new session
          const output = await executePreparedCliRun(context, undefined);
          const effectiveCliSessionId = output.sessionId;
          return buildCliRunResult({ output, effectiveCliSessionId });
        }
        throw err;
      }
      const message = formatErrorMessage(err);
      if (isFailoverErrorMessage(message, { provider: params.provider })) {
        const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(message, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }
      throw err;
    }
  } finally {
    await context.preparedBackend.cleanup?.();
  }
}

export type RunClaudeCliAgentParams = Omit<RunCliAgentParams, "provider" | "cliSessionId"> & {
  provider?: string;
  claudeSessionId?: string;
};

export function buildRunClaudeCliAgentParams(params: RunClaudeCliAgentParams): RunCliAgentParams {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    agentDir: params.agentDir,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    contextTokenBudget: params.contextTokenBudget,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    // Legacy `claudeSessionId` callers predate the shared CLI session contract.
    // Ignore it here so the compatibility wrapper does not accidentally resume
    // an incompatible Claude session on the generic runner path.
    images: params.images,
    senderIsOwner: params.senderIsOwner,
  };
}

export async function runClaudeCliAgent(
  params: RunClaudeCliAgentParams,
): Promise<EmbeddedPiRunResult> {
  return runCliAgent(buildRunClaudeCliAgentParams(params));
}
