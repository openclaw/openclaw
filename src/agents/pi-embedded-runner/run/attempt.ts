import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import type { ActiveToolExecutionState } from "../../pi-embedded-subscribe.types.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
  ToolExecutionSnapshot,
} from "./types.js";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../../../routing/session-key.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { createOllamaStreamFn, OLLAMA_NATIVE_BASE_URL } from "../../ollama-stream.js";
import {
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import { buildEmbeddedExtensionPaths } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeAntigravityThinkingBlocks,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import {
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { detectAndLoadPromptImages } from "./images.js";

export function injectHistoryImagesIntoMessages(
  messages: AgentMessage[],
  historyImagesByIndex: Map<number, ImageContent[]>,
): boolean {
  if (historyImagesByIndex.size === 0) {
    return false;
  }
  let didMutate = false;

  for (const [msgIndex, images] of historyImagesByIndex) {
    // Bounds check: ensure index is valid before accessing
    if (msgIndex < 0 || msgIndex >= messages.length) {
      continue;
    }
    const msg = messages[msgIndex];
    if (msg && msg.role === "user") {
      // Convert string content to array format if needed
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
        didMutate = true;
      }
      if (Array.isArray(msg.content)) {
        // Check for existing image content to avoid duplicates across turns
        const existingImageData = new Set(
          msg.content
            .filter(
              (c): c is ImageContent =>
                c != null &&
                typeof c === "object" &&
                c.type === "image" &&
                typeof c.data === "string",
            )
            .map((c) => c.data),
        );
        for (const img of images) {
          // Only add if this image isn't already in the message
          if (!existingImageData.has(img.data)) {
            msg.content.push(img);
            didMutate = true;
          }
        }
      }
    }
  }

  return didMutate;
}

function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const prevCwd = process.cwd();
  const runAbortController = new AbortController();

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

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
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
      });
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

    // Check if the model supports native image input
    const modelHasVision = params.model.input?.includes("image") ?? false;
    const toolsRaw = params.disableTools
      ? []
      : createOpenClawCodingTools({
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner: params.senderIsOwner,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
          requireExplicitMessageTarget:
            params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
          disableMessageTool: params.disableMessageTool,
        });
    const tools = sanitizeToolsForGoogle({ tools: toolsRaw, provider: params.provider });
    logToolSchemasForGoogle({ tools, provider: params.provider });

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
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider);
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

    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
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
      workspaceNotes,
      reactionGuidance,
      promptMode,
      runtimeInfo,
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
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars: resolveBootstrapMaxChars(params.config),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: params.sessionKey ?? params.sessionId,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: appendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools,
    });
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    const systemPromptText = systemPromptOverride();

    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      await prewarmSessionFile(params.sessionFile);
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        inputProvenance: params.inputProvenance,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      });
      trackSessionManagerAccess(params.sessionFile);

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      const settingsManager = SettingsManager.create(effectiveWorkspace, agentDir);
      ensurePiCompactionReserveTokens({
        settingsManager,
        minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
      });

      // Call for side effects (sets compaction/pruning runtime state)
      buildEmbeddedExtensionPaths({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });

      // Get hook runner early so it's available when creating tools
      const hookRunner = getGlobalHookRunner();

      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      // Add client tools (OpenResponses hosted tools) to customTools
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const clientToolDefs = params.clientTools
        ? toClientToolDefinitions(
            params.clientTools,
            (toolName, toolParams) => {
              clientToolCallDetected = { name: toolName, params: toolParams };
            },
            {
              agentId: sessionAgentId,
              sessionKey: params.sessionKey,
            },
          )
        : [];

      const allCustomTools = [...customTools, ...clientToolDefs];

      ({ session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        model: params.model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools: allCustomTools,
        sessionManager,
        settingsManager,
      }));
      applySystemPromptOverrideToSession(session, systemPromptText);
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });

      // Ollama native API: bypass SDK's streamSimple and use direct /api/chat calls
      // for reliable streaming + tool calling support (#11828).
      if (params.model.api === "ollama") {
        // Use the resolved model baseUrl first so custom provider aliases work.
        const providerConfig = params.config?.models?.providers?.[params.model.provider];
        const modelBaseUrl =
          typeof params.model.baseUrl === "string" ? params.model.baseUrl.trim() : "";
        const providerBaseUrl =
          typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
        const ollamaBaseUrl = modelBaseUrl || providerBaseUrl || OLLAMA_NATIVE_BASE_URL;
        activeSession.agent.streamFn = createOllamaStreamFn(ollamaBaseUrl);
      } else {
        // Force a stable streamFn reference so vitest can reliably mock @mariozechner/pi-ai.
        activeSession.agent.streamFn = streamSimple;
      }

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        params.streamParams,
      );

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }
      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      try {
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
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
        cacheTrace?.recordStage("session:limited", { messages: limited });
        if (limited.length > 0) {
          activeSession.agent.replaceMessages(limited);
        }
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
        });
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let timedOut = false;
      let timedOutDuringCompaction = false;
      let timedOutDuringToolExecution = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        runId: params.runId,
        hookRunner: getGlobalHookRunner() ?? undefined,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
        config: params.config,
        sessionKey: params.sessionKey ?? params.sessionId,
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        getMessagingToolSentTexts,
        getMessagingToolSentTargets,
        didSendViaMessagingTool,
        getLastToolError,
        getUsageTotals,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      let toolStateSnapshot: ActiveToolExecutionState | undefined;
      const abortTimer = setTimeout(
        () => {
          if (!isProbeSession) {
            log.warn(
              `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
            );
          }
          // Capture tool execution state right before classification to minimize timing window
          // where tool could complete between capture and flag check.
          toolStateSnapshot = subscription.getActiveToolExecutionState();
          // Classify timeout based on what was executing when it occurred.
          // Multiple classifications can be true if, for example, tool execution completes
          // and immediately triggers compaction, then timeout fires during compaction.
          if (
            shouldFlagCompactionTimeout({
              isTimeout: true,
              isCompactionPendingOrRetrying: subscription.isCompacting(),
              isCompactionInFlight: activeSession.isCompacting,
            })
          ) {
