import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ensureContextEnginesInitialized,
  resolveContextEngine,
} from "../../context-engine/index.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { type enqueueCommand, enqueueCommandInLane } from "../../process/command-queue.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveSignalReactionLevel } from "../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { listChannelSupportedActions, resolveChannelMessageToolHints } from "../channel-tools.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { getApiKeyForModel, resolveModelAuthMode } from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  createOllamaStreamFn,
  ensureOllamaApiRegistered,
  OLLAMA_NATIVE_BASE_URL,
} from "../ollama-stream.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import {
  ensureSessionHeader,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../pi-embedded-helpers.js";
import { createPreparedEmbeddedPiSettingsManager } from "../pi-project-settings.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { resolveSandboxContext } from "../sandbox.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../session-write-lock.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
  type SkillSnapshot,
} from "../skills.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import {
  compactWithSafetyTimeout,
  EMBEDDED_COMPACTION_TIMEOUT_MS,
} from "./compaction-safety-timeout.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
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
import { resolveEmbeddedRunSkillEntries } from "./skills-runtime.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";
import { collectAllowedToolNames } from "./tool-name-allowlist.js";
import { splitSdkTools } from "./tool-split.js";
import type { EmbeddedPiCompactResult } from "./types.js";
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
  tokenBudget?: number;
  force?: boolean;
  trigger?: "overflow" | "manual";
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

function hasRealConversationContent(msg: AgentMessage): boolean {
  return msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult";
}

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
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
  const fail = (reason: string): EmbeddedPiCompactResult => {
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
  };
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
    return fail(reason);
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
    return fail(reason);
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
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      skillsSnapshot: params.skillsSnapshot,
    });
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
    const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
    });
    // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const ctxInfo = resolveContextWindowInfo({
      cfg: params.config,
      provider,
      modelId,
      modelContextWindow: model.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    const effectiveModel =
      ctxInfo.tokens < (model.contextWindow ?? Infinity)
        ? { ...model, contextWindow: ctxInfo.tokens }
        : model;

    const runAbortController = new AbortController();
    const toolsRaw = createOpenClawCodingTools({
      exec: {
        elevated: params.bashElevated,
      },
      sandbox,
      messageProvider: resolvedMessageProvider,
      agentAccountId: params.agentAccountId,
      sessionKey: sandboxSessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
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
      modelContextWindowTokens: ctxInfo.tokens,
      modelAuthMode: resolveModelAuthMode(model.provider, params.config),
    });
    const tools = sanitizeToolsForGoogle({
      tools: supportsModelTools(model) ? toolsRaw : [],
      provider,
    });
    const allowedToolNames = collectAllowedToolNames({ tools });
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
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);
    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      ownerDisplay: ownerDisplay.ownerDisplay,
      ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      promptMode,
      acpEnabled: params.config?.acp?.enabled !== false,
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
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: EMBEDDED_COMPACTION_TIMEOUT_MS,
      }),
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
        allowedToolNames,
      });
      trackSessionManagerAccess(params.sessionFile);
      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd: effectiveWorkspace,
        agentDir,
        cfg: params.config,
      });
      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider,
        modelId,
        model,
      });
      // Only create an explicit resource loader when there are extension factories
      // to register; otherwise let createAgentSession use its built-in default.
      let resourceLoader: DefaultResourceLoader | undefined;
      if (extensionFactories.length > 0) {
        resourceLoader = new DefaultResourceLoader({
          cwd: resolvedWorkspace,
          agentDir,
          settingsManager,
          extensionFactories,
        });
        await resourceLoader.reload();
      }

      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      const { session } = await createAgentSession({
        cwd: effectiveWorkspace,
        agentDir,
        authStorage,
        modelRegistry,
        model: effectiveModel,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools,
        sessionManager,
        settingsManager,
        resourceLoader,
      });
      applySystemPromptOverrideToSession(session, systemPromptOverride());

      // Ollama native API: register "ollama" in the SDK's API provider
      // registry so that completeSimple() (used by session.compact()) can
      // reach the native /api/chat endpoint (#20652, #11828).
      if (model.api === "ollama") {
        ensureOllamaApiRegistered();
        const providerConfig = params.config?.models?.providers?.[model.provider];
        const modelBaseUrl = typeof model.baseUrl === "string" ? model.baseUrl.trim() : "";
        const providerBaseUrl =
          typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
        const ollamaBaseUrl = modelBaseUrl || providerBaseUrl || OLLAMA_NATIVE_BASE_URL;
        session.agent.streamFn = createOllamaStreamFn(ollamaBaseUrl, model.headers);
      }

      try {
        const prior = await sanitizeSessionHistory({
          messages: session.messages,
          modelApi: model.api,
          modelId,
          provider,
          allowedToolNames,
          config: params.config,
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
        // Apply validated transcript to the live session even when no history limit is configured,
        // so compaction and hook metrics are based on the same message set.
        session.agent.replaceMessages(validated);
        // "Original" compaction metrics should describe the validated transcript that enters
        // limiting/compaction, not the raw on-disk session snapshot.
        const originalMessages = session.messages.slice();
        const truncated = limitHistoryTurns(
          session.messages,
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
        const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
        const hookRunner = getGlobalHookRunner();
        const messageCountOriginal = originalMessages.length;
        let tokenCountOriginal: number | undefined;
        try {
          tokenCountOriginal = 0;
          for (const message of originalMessages) {
            tokenCountOriginal += estimateTokens(message);
          }
        } catch {
          tokenCountOriginal = undefined;
        }
        const messageCountBefore = session.messages.length;
        let tokenCountBefore: number | undefined;
        try {
          tokenCountBefore = 0;
          for (const message of session.messages) {
            tokenCountBefore += estimateTokens(message);
          }
        } catch {
          tokenCountBefore = undefined;
        }
        // TODO(#7175): Consider exposing full message snapshots or pre-compaction injection
        // hooks; current events only report counts/metadata.
        try {
          const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
            sessionId: params.sessionId,
            missingSessionKey,
            messageCount: messageCountBefore,
            tokenCount: tokenCountBefore,
            messageCountOriginal,
            tokenCountOriginal,
          });
          await triggerInternalHook(hookEvent);
        } catch (err) {
          log.warn("session:compact:before hook failed", {
            errorMessage: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack : undefined,
          });
        }
        if (hookRunner?.hasHooks("before_compaction")) {
          try {
            await hookRunner.runBeforeCompaction(
              {
                messageCount: messageCountBefore,
                tokenCount: tokenCountBefore,
              },
              {
                sessionId: params.sessionId,
                agentId: sessionAgentId,
                sessionKey: hookSessionKey,
                workspaceDir: effectiveWorkspace,
                messageProvider: resolvedMessageProvider,
              },
            );
          } catch (err) {
            log.warn("before_compaction hook failed", {
              errorMessage: err instanceof Error ? err.message : String(err),
              errorStack: err instanceof Error ? err.stack : undefined,
            });
          }
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

        if (!session.messages.some(hasRealConversationContent)) {
          log.info(
            `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
          );
          return {
            ok: true,
            compacted: false,
            reason: "no real conversation messages",
          };
        }

        const compactStartedAt = Date.now();
        // Measure compactedCount from the original pre-limiting transcript so compaction
        // lifecycle metrics represent total reduction through the compaction pipeline.
        const messageCountCompactionInput = messageCountOriginal;
        const result = await compactWithSafetyTimeout(() =>
          session.compact(params.customInstructions),
        );
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
        const messageCountAfter = session.messages.length;
        const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
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
        // TODO(#9611): Consider exposing compaction summaries or post-compaction injection;
        // current events only report summary metadata.
        try {
          const hookEvent = createInternalHookEvent("session", "compact:after", hookSessionKey, {
            sessionId: params.sessionId,
            missingSessionKey,
            messageCount: messageCountAfter,
            tokenCount: tokensAfter,
            compactedCount,
            summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
            tokensBefore: result.tokensBefore,
            tokensAfter,
            firstKeptEntryId: result.firstKeptEntryId,
          });
          await triggerInternalHook(hookEvent);
        } catch (err) {
          log.warn("session:compact:after hook failed", {
            errorMessage: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack : undefined,
          });
        }
        if (hookRunner?.hasHooks("after_compaction")) {
          try {
            await hookRunner.runAfterCompaction(
              {
                messageCount: messageCountAfter,
                tokenCount: tokensAfter,
                compactedCount,
              },
              {
                sessionId: params.sessionId,
                agentId: sessionAgentId,
                sessionKey: hookSessionKey,
                workspaceDir: effectiveWorkspace,
                messageProvider: resolvedMessageProvider,
              },
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: err instanceof Error ? err.message : String(err),
              errorStack: err instanceof Error ? err.stack : undefined,
            });
          }
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
          clearPendingOnTimeout: true,
        });
        session.dispose();
      }
    } finally {
      await sessionLock.release();
    }
  } catch (err) {
    const reason = describeUnknownError(err);
    return fail(reason);
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
    enqueueGlobal(async () => {
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      try {
        // Resolve token budget from model context window so the context engine
        // knows the compaction target.  The runner's afterTurn path passes this
        // automatically, but the /compact command path needs to compute it here.
        const ceProvider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
        const ceModelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
        const { model: ceModel } = resolveModel(ceProvider, ceModelId, agentDir, params.config);
        const ceCtxInfo = resolveContextWindowInfo({
          cfg: params.config,
          provider: ceProvider,
          modelId: ceModelId,
          modelContextWindow: ceModel?.contextWindow,
          defaultTokens: DEFAULT_CONTEXT_TOKENS,
        });
        const result = await contextEngine.compact({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          tokenBudget: ceCtxInfo.tokens,
          customInstructions: params.customInstructions,
          force: params.trigger === "manual",
          legacyParams: params as Record<string, unknown>,
        });
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          result: result.result
            ? {
                summary: result.result.summary ?? "",
                firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                tokensBefore: result.result.tokensBefore,
                tokensAfter: result.result.tokensAfter,
                details: result.result.details,
              }
            : undefined,
        };
      } finally {
        await contextEngine.dispose?.();
      }
    }),
  );
}
