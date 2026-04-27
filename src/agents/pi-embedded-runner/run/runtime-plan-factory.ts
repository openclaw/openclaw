import type { Api, Model } from "@mariozechner/pi-ai";
import type { ContextEngine } from "../../../context-engine/types.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  type ResolvedProviderAuth,
} from "../../model-auth.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { EmbeddedRunReplayState } from "../replay-state.js";
import { scrubAnthropicRefusalMagic } from "./helpers.js";
import type { RuntimeAuthState } from "./helpers.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type AttemptPromptInstructions = {
  ackExecutionFastPathInstruction?: string | null;
  planningOnlyRetryInstruction?: string | null;
  reasoningOnlyRetryInstruction?: string | null;
  emptyResponseRetryInstruction?: string | null;
};

export function buildAttemptPrompt(params: {
  provider: string;
  prompt: string;
  instructions: AttemptPromptInstructions;
}): string {
  const basePrompt =
    params.provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;
  const promptAdditions = [
    params.instructions.ackExecutionFastPathInstruction,
    params.instructions.planningOnlyRetryInstruction,
    params.instructions.reasoningOnlyRetryInstruction,
    params.instructions.emptyResponseRetryInstruction,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return promptAdditions.length > 0
    ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}`
    : basePrompt;
}

export function resolveAttemptStreamApiKey(params: {
  runtimeAuthState: RuntimeAuthState | null;
  apiKeyInfo: ResolvedProviderAuth | null;
}): string | undefined {
  return params.runtimeAuthState ? undefined : params.apiKeyInfo?.apiKey;
}

export function buildAttemptRuntimePlan(params: {
  provider: string;
  modelId: string;
  model: Model<Api>;
  harnessId: string;
  pluginHarnessOwnsTransport: boolean;
  lastProfileId?: string;
  config?: RunEmbeddedPiAgentParams["config"];
  workspaceDir: string;
  agentDir: string;
  agentId: string;
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  streamParams?: RunEmbeddedPiAgentParams["streamParams"];
  fastMode?: boolean;
}): AgentRuntimePlan {
  return buildAgentRuntimePlan({
    provider: params.provider,
    modelId: params.modelId,
    model: params.model,
    modelApi: params.model.api,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    allowHarnessAuthProfileForwarding: params.pluginHarnessOwnsTransport,
    authProfileProvider: params.lastProfileId?.split(":", 1)[0],
    sessionAuthProfileId: params.lastProfileId,
    config: params.config,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    agentId: params.agentId,
    thinkingLevel: params.thinkLevel,
    extraParamsOverride: {
      ...params.streamParams,
      fastMode: params.fastMode,
    },
  });
}

export function buildEmbeddedRunAttemptInput(params: {
  runParams: RunEmbeddedPiAgentParams;
  activeSessionId?: string;
  activeSessionFile?: string;
  resolvedSessionKey?: string;
  resolvedWorkspace: string;
  agentDir: string;
  agentId: string;
  isCanonicalWorkspace: boolean;
  contextEngine: ContextEngine;
  contextTokenBudget?: number;
  provider: string;
  modelId: string;
  effectiveModel: Model<Api>;
  harnessId: string;
  pluginHarnessOwnsTransport: boolean;
  apiKeyInfo: ResolvedProviderAuth | null;
  runtimeAuthState: RuntimeAuthState | null;
  lastProfileId?: string;
  lockedProfileId?: string;
  initialReplayState?: EmbeddedRunReplayState;
  authStorage: EmbeddedRunAttemptParams["authStorage"];
  modelRegistry: EmbeddedRunAttemptParams["modelRegistry"];
  legacyBeforeAgentStartResult: EmbeddedRunAttemptParams["legacyBeforeAgentStartResult"];
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  resolvedToolResultFormat: EmbeddedRunAttemptParams["toolResultFormat"];
  bootstrapPromptWarningSignaturesSeen: string[];
  instructions: AttemptPromptInstructions;
}): EmbeddedRunAttemptParams {
  const prompt = buildAttemptPrompt({
    provider: params.provider,
    prompt: params.runParams.prompt,
    instructions: params.instructions,
  });
  const runtimePlan = buildAttemptRuntimePlan({
    provider: params.provider,
    modelId: params.modelId,
    model: params.effectiveModel,
    harnessId: params.harnessId,
    pluginHarnessOwnsTransport: params.pluginHarnessOwnsTransport,
    lastProfileId: params.lastProfileId,
    config: params.runParams.config,
    workspaceDir: params.resolvedWorkspace,
    agentDir: params.agentDir,
    agentId: params.agentId,
    thinkLevel: params.thinkLevel,
    streamParams: params.runParams.streamParams,
    fastMode: params.runParams.fastMode,
  });
  return {
    sessionId: params.activeSessionId ?? params.runParams.sessionId,
    sessionKey: params.resolvedSessionKey,
    sandboxSessionKey: params.runParams.sandboxSessionKey,
    trigger: params.runParams.trigger,
    memoryFlushWritePath: params.runParams.memoryFlushWritePath,
    messageChannel: params.runParams.messageChannel,
    messageProvider: params.runParams.messageProvider,
    agentAccountId: params.runParams.agentAccountId,
    messageTo: params.runParams.messageTo,
    messageThreadId: params.runParams.messageThreadId,
    groupId: params.runParams.groupId,
    groupChannel: params.runParams.groupChannel,
    groupSpace: params.runParams.groupSpace,
    memberRoleIds: params.runParams.memberRoleIds,
    spawnedBy: params.runParams.spawnedBy,
    isCanonicalWorkspace: params.isCanonicalWorkspace,
    senderId: params.runParams.senderId,
    senderName: params.runParams.senderName,
    senderUsername: params.runParams.senderUsername,
    senderE164: params.runParams.senderE164,
    senderIsOwner: params.runParams.senderIsOwner,
    currentChannelId: params.runParams.currentChannelId,
    currentThreadTs: params.runParams.currentThreadTs,
    currentMessageId: params.runParams.currentMessageId,
    replyToMode: params.runParams.replyToMode,
    hasRepliedRef: params.runParams.hasRepliedRef,
    sessionFile: params.activeSessionFile ?? params.runParams.sessionFile,
    workspaceDir: params.resolvedWorkspace,
    agentDir: params.agentDir,
    config: params.runParams.config,
    allowGatewaySubagentBinding: params.runParams.allowGatewaySubagentBinding,
    contextEngine: params.contextEngine,
    contextTokenBudget: params.contextTokenBudget,
    skillsSnapshot: params.runParams.skillsSnapshot,
    prompt,
    transcriptPrompt: params.runParams.transcriptPrompt,
    images: params.runParams.images,
    imageOrder: params.runParams.imageOrder,
    clientTools: params.runParams.clientTools,
    disableTools: params.runParams.disableTools,
    provider: params.provider,
    modelId: params.modelId,
    // Use the harness selected before model/auth setup for the actual attempt too.
    // Otherwise plugin-owned transports can skip PI auth bootstrap but drift back
    // to PI when the attempt is created.
    agentHarnessId: params.harnessId,
    runtimePlan,
    model: applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(params.effectiveModel, params.apiKeyInfo),
      // When runtime auth exchange produced a different credential
      // (runtimeAuthState is set), the exchanged token lives in
      // authStorage and the SDK will pick it up automatically.
      // Skip header injection to avoid leaking the pre-exchange key.
      params.runtimeAuthState ? null : params.apiKeyInfo,
      params.runParams.config,
    ),
    resolvedApiKey: resolveAttemptStreamApiKey({
      runtimeAuthState: params.runtimeAuthState,
      apiKeyInfo: params.apiKeyInfo,
    }),
    authProfileId: params.lastProfileId,
    authProfileIdSource: params.lockedProfileId ? "user" : "auto",
    initialReplayState: params.initialReplayState,
    authStorage: params.authStorage,
    modelRegistry: params.modelRegistry,
    agentId: params.agentId,
    legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
    thinkLevel: params.thinkLevel,
    fastMode: params.runParams.fastMode,
    verboseLevel: params.runParams.verboseLevel,
    reasoningLevel: params.runParams.reasoningLevel,
    toolResultFormat: params.resolvedToolResultFormat,
    execOverrides: params.runParams.execOverrides,
    bashElevated: params.runParams.bashElevated,
    timeoutMs: params.runParams.timeoutMs,
    runId: params.runParams.runId,
    abortSignal: params.runParams.abortSignal,
    replyOperation: params.runParams.replyOperation,
    shouldEmitToolResult: params.runParams.shouldEmitToolResult,
    shouldEmitToolOutput: params.runParams.shouldEmitToolOutput,
    onPartialReply: params.runParams.onPartialReply,
    onAssistantMessageStart: params.runParams.onAssistantMessageStart,
    onBlockReply: params.runParams.onBlockReply,
    onBlockReplyFlush: params.runParams.onBlockReplyFlush,
    blockReplyBreak: params.runParams.blockReplyBreak,
    blockReplyChunking: params.runParams.blockReplyChunking,
    onReasoningStream: params.runParams.onReasoningStream,
    onReasoningEnd: params.runParams.onReasoningEnd,
    onToolResult: params.runParams.onToolResult,
    onAgentEvent: params.runParams.onAgentEvent,
    extraSystemPrompt: params.runParams.extraSystemPrompt,
    inputProvenance: params.runParams.inputProvenance,
    streamParams: params.runParams.streamParams,
    ownerNumbers: params.runParams.ownerNumbers,
    enforceFinalTag: params.runParams.enforceFinalTag,
    silentExpected: params.runParams.silentExpected,
    bootstrapContextMode: params.runParams.bootstrapContextMode,
    bootstrapContextRunKind: params.runParams.bootstrapContextRunKind,
    toolsAllow: params.runParams.toolsAllow,
    disableMessageTool: params.runParams.disableMessageTool,
    forceMessageTool: params.runParams.forceMessageTool,
    requireExplicitMessageTarget: params.runParams.requireExplicitMessageTarget,
    internalEvents: params.runParams.internalEvents,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature:
      params.bootstrapPromptWarningSignaturesSeen[
        params.bootstrapPromptWarningSignaturesSeen.length - 1
      ],
  };
}
