/**
 * SDK-based attempt runner for Claude/Anthropic provider.
 *
 * This replaces `runEmbeddedAttempt()` when `provider === "anthropic"`.
 * It uses the official `@anthropic-ai/claude-agent-sdk` which handles:
 * - LLM API calls via Claude CLI subscription auth
 * - Tool execution loop
 * - Session persistence and resumption
 * - Context compaction
 *
 * OpenClaw's custom tools are provided via an in-process MCP server.
 * OpenClaw's plugin hooks are bridged via the SDK's hook system.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
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
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { listChannelSupportedActions, resolveChannelMessageToolHints } from "../channel-tools.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { resolveModelAuthMode } from "../model-auth.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars } from "../pi-embedded-helpers.js";
import { log } from "../pi-embedded-runner/logger.js";
import { buildModelAliasLines } from "../pi-embedded-runner/model.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { buildEmbeddedSandboxInfo } from "../pi-embedded-runner/sandbox-info.js";
import { buildEmbeddedSystemPrompt } from "../pi-embedded-runner/system-prompt.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { resolveSandboxContext } from "../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../skills.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../workspace.js";
import { buildSdkHooks } from "./hook-bridge.js";
import { buildOpenClawMcpServer } from "./mcp-tool-adapter.js";
import { loadSdkSessionId, storeSdkSessionId } from "./session-bridge.js";
import { consumeSdkStream } from "./stream-adapter.js";
import { isSdkBuiltinTool } from "./types.js";

/**
 * Run a single agent attempt using the claude-agent-sdk.
 *
 * This function is called from `runEmbeddedPiAgent()` in `run.ts` when the
 * resolved provider is "anthropic". It produces the same `EmbeddedRunAttemptResult`
 * shape so the outer retry/failover loop works unchanged.
 */
export async function runSdkAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const runAbortController = new AbortController();

  log.debug(
    `sdk run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId}`,
  );

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  // ── Sandbox resolution ───────────────────────────────────────────────
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

  // ── Skill env setup ──────────────────────────────────────────────────
  let restoreSkillEnv: (() => void) | undefined;
  const prevCwd = process.cwd();
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

    // ── Bootstrap context ────────────────────────────────────────────
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

    // ── Tool creation ────────────────────────────────────────────────
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
    // No Google sanitization needed for Anthropic provider
    const tools = toolsRaw;

    // ── Build system prompt ──────────────────────────────────────────
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
              return resolved.agentReactionGuidance
                ? { level: resolved.agentReactionGuidance, channel: "Telegram" }
                : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              return resolved.agentReactionGuidance
                ? { level: resolved.agentReactionGuidance, channel: "Signal" }
                : undefined;
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

    const systemPromptText = buildEmbeddedSystemPrompt({
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
      bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(params.config),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: params.sessionKey ?? params.sessionId,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: systemPromptText,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools,
    });

    // ── Build MCP server for custom tools ────────────────────────────
    const customTools = tools.filter((t) => !isSdkBuiltinTool(t.name));
    const mcpServer = customTools.length > 0 ? buildOpenClawMcpServer(tools) : undefined;

    // ── Build SDK hooks ──────────────────────────────────────────────
    const hookRunner = getGlobalHookRunner();
    const sdkHooks = buildSdkHooks({ hookRunner: hookRunner ?? undefined });

    // ── Resolve SDK session for resume ───────────────────────────────
    const sdkSessionId = loadSdkSessionId(params.sessionFile);

    // ── Derive allowed tools ─────────────────────────────────────────
    const allowedTools: string[] = [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "NotebookEdit",
      "Task",
      "TaskOutput",
      "TaskStop",
    ];
    if (mcpServer) {
      allowedTools.push("mcp__openclaw__*");
    }

    // ── Abort/timeout handling ───────────────────────────────────────
    let aborted = false;
    let timedOut = false;

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        aborted = true;
        runAbortController.abort(new Error("request timed out"));
      },
      Math.max(1, params.timeoutMs),
    );

    if (params.abortSignal) {
      const onExternalAbort = () => {
        aborted = true;
        runAbortController.abort();
      };
      if (params.abortSignal.aborted) {
        onExternalAbort();
      } else {
        params.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    // ── Call SDK query() ─────────────────────────────────────────────
    try {
      // Emit lifecycle start so the gateway's agent event handler can
      // track this run and deliver streaming chat events to WebChat clients.
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt: Date.now(),
        },
      });

      const q = query({
        prompt: params.prompt,
        options: {
          systemPrompt: systemPromptText,
          model: params.modelId,
          cwd: effectiveWorkspace,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          allowedTools,
          ...(mcpServer ? { mcpServers: { openclaw: mcpServer } } : {}),
          hooks: sdkHooks,
          maxTurns: deriveMaxTurns(params.timeoutMs),
          ...(sdkSessionId ? { resume: sdkSessionId } : {}),
          abortController: runAbortController,
          persistSession: true,
          settingSources: [],
        },
      });

      const result = await consumeSdkStream({
        runId: params.runId,
        queryIterator: q,
        reasoningMode: params.reasoningLevel ?? "off",
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onReasoningStream: params.onReasoningStream,
        onReasoningEnd: params.onReasoningEnd,
        onToolResult: params.onToolResult,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
        abortSignal: runAbortController.signal,
      });

      // Store SDK session ID for future resume
      if (result.sessionId) {
        storeSdkSessionId(params.sessionFile, result.sessionId);
      }

      clearTimeout(timeoutTimer);

      // Persist user + assistant messages to the OpenClaw transcript so
      // chat.history returns them (the SDK has its own separate persistence).
      const finalAssistantText = result.assistantTexts.join("\n\n").trim();
      persistToTranscript({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        prompt: params.prompt,
        assistantText: finalAssistantText,
        modelId: params.modelId,
        provider: params.provider,
      });

      // Emit lifecycle end/error so the gateway finalizes the webchat response.
      if (result.error) {
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            error:
              result.error instanceof Error
                ? result.error.message
                : typeof result.error === "string"
                  ? result.error
                  : "SDK run failed",
            endedAt: Date.now(),
          },
        });
      } else {
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt: Date.now(),
          },
        });
      }

      return {
        aborted: result.aborted || aborted,
        timedOut: result.timedOut || timedOut,
        timedOutDuringCompaction: false,
        promptError: result.error,
        sessionIdUsed: result.sessionId || params.sessionId,
        systemPromptReport,
        messagesSnapshot: [],
        assistantTexts: result.assistantTexts,
        toolMetas: result.toolMetas,
        lastAssistant: result.lastAssistant,
        lastToolError: result.lastToolError,
        didSendViaMessagingTool: result.didSendViaMessagingTool,
        messagingToolSentTexts: result.messagingToolSentTexts,
        messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
        messagingToolSentTargets: result.messagingToolSentTargets,
        successfulCronAdds: result.successfulCronAdds,
        cloudCodeAssistFormatError: false,
        attemptUsage: result.usage,
        compactionCount: result.compactionCount,
      };
    } catch (err) {
      clearTimeout(timeoutTimer);

      // Emit lifecycle error so the gateway finalizes the webchat response.
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
          endedAt: Date.now(),
        },
      });

      return {
        aborted: aborted || params.abortSignal?.aborted === true,
        timedOut,
        timedOutDuringCompaction: false,
        promptError: err,
        sessionIdUsed: params.sessionId,
        systemPromptReport,
        messagesSnapshot: [],
        assistantTexts: [],
        toolMetas: [],
        lastAssistant: undefined,
        lastToolError: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        successfulCronAdds: 0,
        cloudCodeAssistFormatError: false,
        attemptUsage: undefined,
        compactionCount: 0,
      };
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}

/**
 * Derive a reasonable maxTurns from timeout milliseconds.
 * Each turn takes ~5-30 seconds depending on tool usage, so we estimate
 * conservatively. The SDK will also respect its own timeout mechanisms.
 */
function deriveMaxTurns(timeoutMs: number): number {
  // Allow roughly 1 turn per 10 seconds of timeout, with a minimum of 5 and max of 200
  const estimated = Math.floor(timeoutMs / 10_000);
  return Math.max(5, Math.min(200, estimated));
}

/**
 * Persist user prompt and assistant reply to the OpenClaw transcript file
 * so that `chat.history` can return them. The SDK manages its own session
 * persistence, but the gateway's WebChat reads from the OpenClaw transcript.
 */
function persistToTranscript(params: {
  sessionFile: string;
  sessionId: string;
  prompt: string;
  assistantText: string;
  modelId: string;
  provider: string;
}): void {
  try {
    // Ensure the transcript file exists with a proper header.
    if (!fsSync.existsSync(params.sessionFile)) {
      fsSync.mkdirSync(path.dirname(params.sessionFile), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fsSync.writeFileSync(params.sessionFile, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }

    const sm = SessionManager.open(params.sessionFile);
    const now = Date.now();

    // Append user message
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: params.prompt }],
      timestamp: now,
    });

    // Append assistant message
    if (params.assistantText.trim()) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: params.assistantText }],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
        api: "anthropic-messages",
        provider: params.provider,
        model: params.modelId,
      } as Parameters<SessionManager["appendMessage"]>[0]);
    }
  } catch {
    // Non-fatal: failing to persist doesn't break the run itself.
  }
}
