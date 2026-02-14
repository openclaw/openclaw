import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createAgentSession,
  estimateTokens,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { EmbeddedPiCompactResult } from "./types.js";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { type enqueueCommand, enqueueCommandInLane } from "../../process/command-queue.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveSignalReactionLevel } from "../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { listChannelSupportedActions, resolveChannelMessageToolHints } from "../channel-tools.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { getApiKeyForModel, resolveModelAuthMode } from "../model-auth.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  ensureSessionHeader,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../pi-embedded-helpers.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "../pi-settings.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { resolveSandboxContext } from "../sandbox.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  type SkillSnapshot,
} from "../skills.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { buildEmbeddedExtensionPaths } from "./extensions.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "./google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { buildModelAliasLines, resolveModel } from "./model.js";
import { buildEmbeddedSandboxInfo } from "./sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";
import { splitSdkTools } from "./tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

export type CompactEmbeddedPiSessionParams = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  authProfileId?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Whether the sender is an owner (required for owner-only tools). */
  senderIsOwner?: boolean;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  trigger?: "overflow" | "manual" | "cache_ttl" | "safeguard";
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
};

type CompactionMessageMetrics = {
  messages: number;
  historyTextChars: number;
  toolResultChars: number;
  estTokens?: number;
  contributors: Array<{ role: string; chars: number; tool?: string }>;
};

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getMessageTextChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens = 0;
  let tokenEstimationFailed = false;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });
    if (!tokenEstimationFailed) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        tokenEstimationFailed = true;
      }
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens: tokenEstimationFailed ? undefined : estTokens,
    contributors: contributors.toSorted((a, b) => b.chars - a.chars).slice(0, 3),
  };
}

function classifyCompactionReason(reason?: string): string {
  const text = (reason ?? "").trim().toLowerCase();
  if (!text) {
    return "unknown";
  }
  if (text.includes("nothing to compact")) {
    return "no_compactable_entries";
  }
  if (text.includes("below threshold")) {
    return "below_threshold";
  }
  if (text.includes("already compacted")) {
    return "already_compacted_recently";
  }
  if (text.includes("guard")) {
    return "guard_blocked";
  }
  if (text.includes("summary")) {
    return "summary_failed";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  if (
    text.includes("400") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("429")
  ) {
    return "provider_error_4xx";
  }
  if (
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  ) {
    return "provider_error_5xx";
  }
  return "unknown";
}

/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export async function compactEmbeddedPiSessionDirect(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  const startedAt = Date.now();
  const diagId = params.diagId?.trim() || createCompactionDiagId();
  const trigger = params.trigger ?? "manual";
  const attempt = params.attempt ?? 1;
  const maxAttempts = params.maxAttempts ?? 1;
  const runId = params.runId ?? params.sessionId;
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const prevCwd = process.cwd();

  const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  await ensureOpenClawModelsJson(params.config, agentDir);
  const { model, error, authStorage, modelRegistry } = resolveModel(
    provider,
    modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    const reason = error ?? `Unknown model: ${provider}/${modelId}`;
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${classifyCompactionReason(reason)} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
    };
  }
  try {
    const apiKeyInfo = await getApiKeyForModel({
      model,
      cfg: params.config,
      profileId: params.authProfileId,
      agentDir,
    });

    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new Error(
          `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
    } else if (model.provider === "github-copilot") {
      const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({
        githubToken: apiKeyInfo.apiKey,
      });
      authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
    } else {
      authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
    }
  } catch (err) {
    const reason = describeUnknownError(err);
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${classifyCompactionReason(reason)} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
    };
  }

  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  await ensureSessionHeader({
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    cwd: effectiveWorkspace,
  });

  let restoreSkillEnv: (() => void) | undefined;
  process.chdir(effectiveWorkspace);
  try {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const skillEntries = shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(effectiveWorkspace)
      : [];
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
    });
    const runAbortController = new AbortController();
    const toolsRaw = createOpenClawCodingTools({
      exec: {
        elevated: params.bashElevated,
      },
      sandbox,
      messageProvider: params.messageChannel ?? params.messageProvider,
      agentAccountId: params.agentAccountId,
      sessionKey: params.sessionKey ?? params.sessionId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderIsOwner: params.senderIsOwner,
      agentDir,
      workspaceDir: effectiveWorkspace,
      config: params.config,
      abortSignal: runAbortController.signal,
      modelProvider: model.provider,
      modelId,
      modelAuthMode: resolveModelAuthMode(model.provider, params.config),
    });
    const tools = sanitizeToolsForGoogle({ tools: toolsRaw, provider });
    logToolSchemasForGoogle({ tools, provider });
    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) {
          runtimeCapabilities = [];
        }
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const runtimeInfo = {
      host: machineName,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: `${provider}/${modelId}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      capabilities: runtimeCapabilities,
      channelActions,
    };
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(provider);
    const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
    const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
    const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode = isSubagentSessionKey(params.sessionKey) ? "minimal" : "full";
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      promptMode,
      runtimeInfo,
      reactionGuidance,
      messageToolHints,
      sandboxInfo,
      tools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles,
      memoryCitationsMode: params.config?.memory?.citations,
    });
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);

    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      await prewarmSessionFile(params.sessionFile);
      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: model.api,
        provider,
        modelId,
      });
      const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      });
      trackSessionManagerAccess(params.sessionFile);
      const settingsManager = SettingsManager.create(effectiveWorkspace, agentDir);
      ensurePiCompactionReserveTokens({
        settingsManager,
        minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
      });
      // Call for side effects (sets compaction/pruning runtime state)
      buildEmbeddedExtensionPaths({
        cfg: params.config,
        sessionManager,
        provider,
        modelId,
        model,
      });

      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      const { session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage,
        modelRegistry,
        model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools,
        sessionManager,
        settingsManager,
      });
      applySystemPromptOverrideToSession(session, systemPromptOverride());

      try {
        const prior = await sanitizeSessionHistory({
          messages: session.messages,
          modelApi: model.api,
          modelId,
          provider,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
        // Capture full message history BEFORE limiting — plugins need the complete conversation
        const preCompactionMessages = [...session.messages];
        const truncated = limitHistoryTurns(
          validated,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        // Re-run tool_use/tool_result pairing repair after truncation, since
        // limitHistoryTurns can orphan tool_result blocks by removing the
        // assistant message that contained the matching tool_use.
        const limited = transcriptPolicy.repairToolUseResultPairing
          ? sanitizeToolUseResultPairing(truncated)
          : truncated;
        if (limited.length > 0) {
          session.agent.replaceMessages(limited);
        }
        // Run before_compaction hooks (fire-and-forget).
        // The session JSONL already contains all messages on disk, so plugins
        // can read sessionFile asynchronously and process in parallel with
        // the compaction LLM call — no need to block or wait for after_compaction.
        const hookRunner = getGlobalHookRunner();
        const hookCtx = {
          agentId: params.sessionKey?.split(":")[0] ?? "main",
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageChannel ?? params.messageProvider,
        };
        if (hookRunner?.hasHooks("before_compaction")) {
          hookRunner
            .runBeforeCompaction(
              {
                messageCount: preCompactionMessages.length,
                compactingCount: limited.length,
                messages: preCompactionMessages,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            )
            .catch((hookErr: unknown) => {
              log.warn(`before_compaction hook failed: ${String(hookErr)}`);
            });
        }

        const diagEnabled = log.isEnabled("debug");
        const preMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : undefined;
        if (diagEnabled && preMetrics) {
          log.debug(
            `[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
              `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
              `attempt=${attempt} maxAttempts=${maxAttempts} ` +
              `pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} ` +
              `pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`,
          );
          log.debug(
            `[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`,
          );
        }

        const compactStartedAt = Date.now();
        const result = await session.compact(params.customInstructions);
        // Estimate tokens after compaction by summing token estimates for remaining messages
        let tokensAfter: number | undefined;
        try {
          tokensAfter = 0;
          for (const message of session.messages) {
            tokensAfter += estimateTokens(message);
          }
          // Sanity check: tokensAfter should be less than tokensBefore
          if (tokensAfter > result.tokensBefore) {
            tokensAfter = undefined; // Don't trust the estimate
          }
        } catch {
          // If estimation fails, leave tokensAfter undefined
          tokensAfter = undefined;
        }
        // Run after_compaction hooks (fire-and-forget).
        // Also includes sessionFile for plugins that only need to act after
        // compaction completes (e.g. analytics, cleanup).
        if (hookRunner?.hasHooks("after_compaction")) {
          hookRunner
            .runAfterCompaction(
              {
                messageCount: session.messages.length,
                tokenCount: tokensAfter,
                compactedCount: limited.length - session.messages.length,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            )
            .catch((hookErr) => {
              log.warn(`after_compaction hook failed: ${hookErr}`);
            });
        }

        const postMetrics = diagEnabled ? summarizeCompactionMessages(session.messages) : undefined;
        if (diagEnabled && preMetrics && postMetrics) {
          log.debug(
            `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
              `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
              `attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none ` +
              `durationMs=${Date.now() - compactStartedAt} retrying=false ` +
              `post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} ` +
              `post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} ` +
              `delta.messages=${postMetrics.messages - preMetrics.messages} ` +
              `delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} ` +
              `delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} ` +
              `delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`,
          );
        }
        return {
          ok: true,
          compacted: true,
          result: {
            summary: result.summary,
            firstKeptEntryId: result.firstKeptEntryId,
            tokensBefore: result.tokensBefore,
            tokensAfter,
            details: result.details,
          },
        };
      } finally {
        await flushPendingToolResultsAfterIdle({
          agent: session?.agent,
          sessionManager,
        });
        session.dispose();
      }
    } finally {
      await sessionLock.release();
    }
  } catch (err) {
    const reason = describeUnknownError(err);
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${classifyCompactionReason(reason)} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
    };
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedPiSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => compactEmbeddedPiSessionDirect(params)),
  );
}
