import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { generateSecureToken } from "../../infra/secure-random.js";

import { resolveSignalReactionLevel } from "../../plugin-sdk/signal.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramReactionLevel,
} from "../../plugin-sdk/telegram.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { prepareProviderRuntimeAuth } from "../../plugins/provider-runtime.js";
import { type enqueueCommand, enqueueCommandInLane } from "../../process/command-queue.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { listChannelSupportedActions, resolveChannelMessageToolHints } from "../channel-tools.js";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "../compaction-real-conversation.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import {
  applyLocalNoAuthHeaderOverride,
  getApiKeyForModel,
  resolveModelAuthMode,
} from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import { createBundleLspToolRuntime } from "../pi-bundle-lsp-runtime.js";
import { createBundleMcpToolRuntime } from "../pi-bundle-mcp-tools.js";
import {
  ensureSessionHeader,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../pi-embedded-helpers.js";
import {
  consumeCompactionSafeguardCancelReason,
  setCompactionSafeguardCancelReason,
} from "../pi-extensions/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedPiSettingsManager } from "../pi-project-settings.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
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
import { classifyCompactionReason, resolveCompactionFailureReason } from "./compact-reasons.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "./google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";
import { buildModelAliasLines, resolveModelAsync } from "./model.js";
import { buildEmbeddedSandboxInfo } from "./sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import { truncateSessionAfterCompaction } from "./session-truncation.js";
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

const memLog = createSubsystemLogger("memory");

export type CompactEmbeddedPiSessionParams = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  /** Trusted sender id from inbound context for scoped message-tool discovery. */
  senderId?: string;
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
  /** Optional caller-observed live prompt tokens used for compaction diagnostics. */
  currentTokenCount?: number;
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
  trigger?: "budget" | "overflow" | "manual";
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  abortSignal?: AbortSignal;
  /** Allow runtime plugins for this compaction to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
};

type CompactionMessageMetrics = {
  messages: number;
  historyTextChars: number;
  toolResultChars: number;
  estTokens?: number;
  contributors: Array<{ role: string; chars: number; tool?: string }>;
};

function hasRealConversationContent(
  msg: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  return isRealConversationMessage(msg, messages, index);
}

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

function normalizeObservedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
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



function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    hasRealConversationContent(message, allMessages, index),
  );
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
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: resolvedWorkspace,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  // Resolve compaction model: prefer config override, then fall back to caller-supplied model
  const compactionModelOverride = params.config?.agents?.defaults?.compaction?.model?.trim();
  let provider: string;
  let modelId: string;
  // When switching provider via override, drop the primary auth profile to avoid
  // sending the wrong credentials (e.g. OpenAI profile token to OpenRouter).
  let authProfileId: string | undefined = params.authProfileId;
  if (compactionModelOverride) {
    const slashIdx = compactionModelOverride.indexOf("/");
    if (slashIdx > 0) {
      provider = compactionModelOverride.slice(0, slashIdx).trim();
      modelId = compactionModelOverride.slice(slashIdx + 1).trim() || DEFAULT_MODEL;
      // Provider changed — drop primary auth profile so getApiKeyForModel
      // falls back to provider-based key resolution for the override model.
      if (provider !== (params.provider ?? "").trim()) {
        authProfileId = undefined;
      }
    } else {
      provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      modelId = compactionModelOverride;
    }
  } else {
    provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  }
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
  const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
    provider,
    modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    const reason = error ?? `Unknown model: ${provider}/${modelId}`;
    return fail(reason);
  }
  let runtimeModel = model;
  let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>> | null = null;
  try {
    apiKeyInfo = await getApiKeyForModel({
      model: runtimeModel,
      cfg: params.config,
      profileId: authProfileId,
      agentDir,
    });

    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new Error(
          `No API key resolved for provider "${runtimeModel.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
    } else {
      const preparedAuth = await prepareProviderRuntimeAuth({
        provider: runtimeModel.provider,
        config: params.config,
        workspaceDir: resolvedWorkspace,
        env: process.env,
        context: {
          config: params.config,
          agentDir,
          workspaceDir: resolvedWorkspace,
          env: process.env,
          provider: runtimeModel.provider,
          modelId,
          model: runtimeModel,
          apiKey: apiKeyInfo.apiKey,
          authMode: apiKeyInfo.mode,
          profileId: apiKeyInfo.profileId,
        },
      });
      if (preparedAuth?.baseUrl) {
        runtimeModel = { ...runtimeModel, baseUrl: preparedAuth.baseUrl };
      }
      const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
      if (!runtimeApiKey) {
        throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
      }
      authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
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
  let compactionSessionManager: unknown = null;
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
      warn: makeBootstrapWarn({
        sessionLabel,
        warn: (message) => log.warn(message),
      }),
    });
    // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const ctxInfo = resolveContextWindowInfo({
      cfg: params.config,
      provider,
      modelId,
      modelContextWindow: runtimeModel.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    const effectiveModel = applyLocalNoAuthHeaderOverride(
      ctxInfo.tokens < (runtimeModel.contextWindow ?? Infinity)
        ? { ...runtimeModel, contextWindow: ctxInfo.tokens }
        : runtimeModel,
      apiKeyInfo,
    );

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
      allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      agentDir,
      workspaceDir: effectiveWorkspace,
      config: params.config,
      abortSignal: runAbortController.signal,
      modelProvider: model.provider,
      modelId,
      modelCompat: effectiveModel.compat,
      modelContextWindowTokens: ctxInfo.tokens,
      modelAuthMode: resolveModelAuthMode(model.provider, params.config),
    });
    const toolsEnabled = supportsModelTools(runtimeModel);
    const tools = sanitizeToolsForGoogle({
      tools: toolsEnabled ? toolsRaw : [],
      provider,
    });
    const bundleMcpRuntime = toolsEnabled
      ? await createBundleMcpToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: tools.map((tool) => tool.name),
        })
      : undefined;
    const bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const effectiveTools = [
      ...tools,
      ...(bundleMcpRuntime?.tools ?? []),
      ...(bundleLspRuntime?.tools ?? []),
    ];
    const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
    logToolSchemasForGoogle({ tools: effectiveTools, provider });
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
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            accountId: params.agentAccountId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            senderId: params.senderId,
          }),
        )
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
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveWorkspace,
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
      tools: effectiveTools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles,
      memoryCitationsMode: params.config?.memory?.citations,
    });
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: compactionTimeoutMs,
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
      compactionSessionManager = sessionManager;
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
        tools: effectiveTools,
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
      const providerStreamFn = registerProviderStreamForModel({
        model,
        cfg: params.config,
        agentDir,
        workspaceDir: effectiveWorkspace,
      });
      if (providerStreamFn) {
        session.agent.streamFn = providerStreamFn;
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
        const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
        const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
        const beforeHookMetrics = buildBeforeCompactionHookMetrics({
          originalMessages,
          currentMessages: session.messages,
          observedTokenCount,
          estimateTokensFn: estimateTokens,
        });
        const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
          hookRunner,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionAgentId,
          workspaceDir: effectiveWorkspace,
          messageProvider: resolvedMessageProvider,
          metrics: beforeHookMetrics,
        });
        const { messageCountOriginal } = beforeHookMetrics;
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

        if (!containsRealConversationMessages(session.messages)) {
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
        // Estimate full session tokens BEFORE compaction (including system prompt,
        // bootstrap context, workspace files, and all history). This is needed for
        // a correct sanity check — result.tokensBefore only covers the summarizable
        // history subset, not the full session.
        let fullSessionTokensBefore = 0;
        try {
          fullSessionTokensBefore = limited.reduce((sum, msg) => sum + estimateTokens(msg), 0);
        } catch {
          // If token estimation throws on a malformed message, fall back to 0 so
          // the sanity check below becomes a no-op instead of crashing compaction.
        }
        const result = await compactWithSafetyTimeout(
          () => {
            setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
            return session.compact(params.customInstructions);
          },
          compactionTimeoutMs,
          {
            abortSignal: params.abortSignal,
            onCancel: () => {
              session.abortCompaction();
            },
          },
        );
        await runPostCompactionSideEffects({
          config: params.config,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
        });
        // Estimate tokens after compaction by summing token estimates for remaining messages
        const tokensAfter = estimateTokensAfterCompaction({
          messagesAfter: session.messages,
          observedTokenCount,
          fullSessionTokensBefore,
          estimateTokensFn: estimateTokens,
        });
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
        await runAfterCompactionHooks({
          hookRunner,
          sessionId: params.sessionId,
          sessionAgentId,
          hookSessionKey,
          missingSessionKey,
          workspaceDir: effectiveWorkspace,
          messageProvider: resolvedMessageProvider,
          messageCountAfter,
          tokensAfter,
          compactedCount,
          sessionFile: params.sessionFile,
          summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
          tokensBefore: result.tokensBefore,
          firstKeptEntryId: result.firstKeptEntryId,
        });
        // Truncate session file to remove compacted entries (#39953)
        if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction) {
          try {
            const truncResult = await truncateSessionAfterCompaction({
              sessionFile: params.sessionFile,
            });
            if (truncResult.truncated) {
              log.info(
                `[compaction] post-compaction truncation removed ${truncResult.entriesRemoved} entries ` +
                  `(sessionKey=${params.sessionKey ?? params.sessionId})`,
              );
            }
          } catch (err) {
            log.warn("[compaction] post-compaction truncation failed", {
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
            tokensBefore: observedTokenCount ?? result.tokensBefore,
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
        await bundleMcpRuntime?.dispose();
        await bundleLspRuntime?.dispose();
      }
    } finally {
      await sessionLock.release();
    }
  } catch (err) {
    const reason = resolveCompactionFailureReason({
      reason: describeUnknownError(err),
      safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager),
    });
    return fail(reason);
  } finally {
    restoreSkillEnv?.();
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
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: params.workspaceDir,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      try {
        // Resolve token budget from model context window so the context engine
        // knows the compaction target.  The runner's afterTurn path passes this
        // automatically, but the /compact command path needs to compute it here.
        const ceProvider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
        const ceModelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
        const { model: ceModel } = await resolveModelAsync(
          ceProvider,
          ceModelId,
          agentDir,
          params.config,
        );
        const ceCtxInfo = resolveContextWindowInfo({
          cfg: params.config,
          provider: ceProvider,
          modelId: ceModelId,
          modelContextWindow: ceModel?.contextWindow,
          defaultTokens: DEFAULT_CONTEXT_TOKENS,
        });
        // When the context engine owns compaction, its compact() implementation
        // bypasses compactEmbeddedPiSessionDirect (which fires the hooks internally).
        // Fire before_compaction / after_compaction hooks here so plugin subscribers
        // are notified regardless of which engine is active.
        const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
        const hookRunner = engineOwnsCompaction
          ? asCompactionHookRunner(getGlobalHookRunner())
          : null;
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
        const { sessionAgentId } = resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        });
        const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
        const hookCtx = {
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: resolveUserPath(params.workspaceDir),
          messageProvider: resolvedMessageProvider,
        };
        // Engine-owned compaction doesn't load the transcript at this level, so
        // message counts are unavailable.  We pass sessionFile so hook subscribers
        // can read the transcript themselves if they need exact counts.
        if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) {
          try {
            await hookRunner.runBeforeCompaction(
              {
                messageCount: -1,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            );
          } catch (err) {
            log.warn("before_compaction hook failed", {
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const result = await contextEngine.compact({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: ceCtxInfo.tokens,
          currentTokenCount: params.currentTokenCount,
          compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
          customInstructions: params.customInstructions,
          force: params.trigger === "manual",
          runtimeContext: params as Record<string, unknown>,
        });
        if (result.ok && result.compacted) {
          await runContextEngineMaintenance({
            contextEngine,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "compaction",
            runtimeContext: params as Record<string, unknown>,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
          });
        }
        if (
          result.ok &&
          result.compacted &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: result.result?.tokensAfter,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            );
          } catch (err) {
            log.warn("after_compaction hook failed", {
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        }
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

export const __testing = {
  hasRealConversationContent,
  hasMeaningfulConversationContent,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  buildBeforeCompactionHookMetrics,
  runBeforeCompactionHooks,
  runAfterCompactionHooks,
  runPostCompactionSideEffects,
} as const;

export { runPostCompactionSideEffects } from "./compaction-hooks.js";
