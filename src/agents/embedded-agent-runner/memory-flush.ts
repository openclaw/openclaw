import type { runMemoryFlushIfNeeded as runMemoryFlushIfNeededType } from "../../auto-reply/reply/agent-runner-memory.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { VerboseLevel } from "../../auto-reply/thinking.js";
import { getSessionEntry, resolveStorePath, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

export type EmbeddedPreAttemptMemoryFlushResult = {
  attempted: boolean;
  sessionEntry?: SessionEntry;
};

function buildEmbeddedMemoryFlushTemplateContext(params: RunEmbeddedAgentParams): TemplateContext {
  return {
    Provider: params.messageProvider,
    OriginatingChannel: params.messageProvider,
    OriginatingTo: params.messageTo,
    To: params.messageTo,
    AccountId: params.agentAccountId,
    ChatType: params.chatType,
    MessageThreadId: params.messageThreadId,
    SenderId: params.senderId ?? undefined,
    SenderName: params.senderName ?? undefined,
    SenderUsername: params.senderUsername ?? undefined,
    SenderE164: params.senderE164 ?? undefined,
    MemberRoleIds: params.memberRoleIds,
    MessageSid: params.currentMessageId,
    MessageSidFull: params.currentMessageId,
    ReplyToId: params.currentMessageId,
    InputProvenance: params.inputProvenance,
  } as TemplateContext;
}

function buildEmbeddedMemoryFlushFollowupRun(params: {
  runParams: RunEmbeddedAgentParams;
  cfg: OpenClawConfig;
  sessionId: string;
  sessionFile: string;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  agentId: string;
  agentDir: string;
  provider: string;
  model: string;
}): FollowupRun {
  const runParams = params.runParams;
  return {
    // Keep the synthetic flush route free of pending-turn user content/media. The
    // live prompt is passed separately as promptForEstimate for threshold math;
    // the actual model call is driven by the memory flush plan prompt.
    prompt: "",
    transcriptPrompt: "",
    abortSignal: runParams.abortSignal,
    enqueuedAt: Date.now(),
    originatingChannel: runParams.messageProvider,
    originatingTo: runParams.messageTo,
    originatingAccountId: runParams.agentAccountId,
    originatingThreadId: runParams.messageThreadId,
    originatingChatType: runParams.chatType,
    run: {
      agentId: params.agentId,
      agentDir: params.agentDir,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runtimePolicySessionKey: params.runtimePolicySessionKey,
      messageProvider: runParams.messageProvider,
      chatType: runParams.chatType,
      agentAccountId: runParams.agentAccountId,
      groupId: runParams.groupId ?? undefined,
      groupChannel: runParams.groupChannel ?? undefined,
      groupSpace: runParams.groupSpace ?? undefined,
      senderId: runParams.senderId ?? undefined,
      senderName: runParams.senderName ?? undefined,
      senderUsername: runParams.senderUsername ?? undefined,
      senderE164: runParams.senderE164 ?? undefined,
      senderIsOwner: runParams.senderIsOwner,
      approvalReviewerDeviceId: runParams.approvalReviewerDeviceId,
      sessionFile: params.sessionFile,
      workspaceDir: runParams.workspaceDir,
      cwd: runParams.cwd,
      config: params.cfg,
      skillsSnapshot: runParams.skillsSnapshot,
      provider: params.provider,
      model: params.model,
      authProfileId: runParams.authProfileId,
      authProfileIdSource: runParams.authProfileIdSource,
      thinkLevel: runParams.thinkLevel,
      fastMode: runParams.fastMode,
      fastModeAutoOnSeconds: runParams.fastModeAutoOnSeconds,
      verboseLevel: runParams.verboseLevel,
      reasoningLevel: runParams.reasoningLevel,
      execOverrides: runParams.execOverrides,
      bashElevated: runParams.bashElevated,
      timeoutMs: runParams.timeoutMs,
      runTimeoutOverrideMs: runParams.runTimeoutOverrideMs,
      blockReplyBreak: runParams.blockReplyBreak ?? "text_end",
      ownerNumbers: runParams.ownerNumbers,
      inputProvenance: runParams.inputProvenance,
      extraSystemPrompt: runParams.extraSystemPrompt,
      sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
      silentReplyPromptMode: runParams.silentReplyPromptMode,
      enforceFinalTag: runParams.enforceFinalTag,
      silentExpected: true,
      suppressNextUserMessagePersistence: runParams.suppressNextUserMessagePersistence,
      suppressTranscriptOnlyAssistantPersistence:
        runParams.suppressTranscriptOnlyAssistantPersistence,
      skipProviderRuntimeHints: true,
    },
  };
}

export async function runEmbeddedPreAttemptMemoryFlushIfNeeded(params: {
  runParams: RunEmbeddedAgentParams;
  cfg: OpenClawConfig;
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  agentId: string;
  agentDir: string;
  provider: string;
  model: string;
  contextWindowTokens?: number;
  attemptedThisRun?: boolean;
  verboseLevel?: VerboseLevel;
}): Promise<EmbeddedPreAttemptMemoryFlushResult> {
  if (params.runParams.trigger === "memory" || params.attemptedThisRun === true) {
    return { attempted: false };
  }
  if (!params.sessionKey || !params.runParams.replyOperation) {
    return { attempted: false };
  }

  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const sessionEntry = getSessionEntry({
    storePath,
    sessionKey: params.sessionKey,
  });
  if (!sessionEntry) {
    return { attempted: false };
  }

  const sessionStore: Record<string, SessionEntry> = {
    [params.sessionKey]: sessionEntry,
  };
  const followupRun = buildEmbeddedMemoryFlushFollowupRun({
    runParams: params.runParams,
    cfg: params.cfg,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    runtimePolicySessionKey: params.runtimePolicySessionKey,
    agentId: params.agentId,
    agentDir: params.agentDir,
    provider: params.provider,
    model: params.model,
  });

  const { runMemoryFlushIfNeeded } =
    (await import("../../auto-reply/reply/agent-runner-memory.js")) as {
      runMemoryFlushIfNeeded: typeof runMemoryFlushIfNeededType;
    };

  const updatedEntry = await runMemoryFlushIfNeeded({
    cfg: params.cfg,
    followupRun,
    promptForEstimate: params.runParams.prompt,
    sessionCtx: buildEmbeddedMemoryFlushTemplateContext(params.runParams),
    defaultModel: params.model,
    agentCfgContextTokens: params.contextWindowTokens,
    resolvedVerboseLevel: params.verboseLevel ?? params.runParams.verboseLevel ?? "off",
    sessionEntry,
    sessionStore,
    sessionKey: params.sessionKey,
    runtimePolicySessionKey: params.runtimePolicySessionKey,
    storePath,
    isHeartbeat: params.runParams.trigger === "heartbeat",
    replyOperation: params.runParams.replyOperation,
  });

  return {
    attempted: updatedEntry !== sessionEntry,
    sessionEntry: updatedEntry ?? sessionStore[params.sessionKey],
  };
}
