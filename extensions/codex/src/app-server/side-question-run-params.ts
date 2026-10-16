import type {
  AgentHarnessSideQuestionParamsV2,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexEffectiveSessionPermissionPolicy } from "./session-permission-policy.js";

/** Side runs inherit the native binding's model without carrying outer model metadata. */
export function applySideQuestionModelSelection(
  params: AgentHarnessSideQuestionParamsV2,
  selection: { model: string; modelProvider: string } | undefined,
): AgentHarnessSideQuestionParamsV2 {
  return selection
    ? {
        ...params,
        provider: selection.modelProvider,
        model: selection.model,
        runtimeModel: {
          id: selection.model,
          name: selection.model,
          provider: selection.modelProvider,
          api: "openai-chatgpt-responses",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // SAFETY: native side runs consume binding capabilities, not generic model token limits.
        } as NonNullable<AgentHarnessSideQuestionParamsV2["runtimeModel"]>,
      }
    : params;
}

export function buildSideRunAttemptParams(
  params: AgentHarnessSideQuestionParamsV2,
  options: {
    cwd: string;
    authProfileId?: string;
    runId: string;
    timeoutMs: number;
    permissionPolicy?: CodexEffectiveSessionPermissionPolicy;
  },
): EmbeddedRunAttemptParamsV2 {
  const sideParams = {
    params,
    config: params.cfg,
    agentDir: params.agentDir,
    provider: params.provider,
    modelId: params.model,
    // SAFETY: the fallback is only an opaque model identity for native side-question routing.
    model: params.runtimeModel ?? ({ id: params.model, provider: params.provider } as never),
    prompt: params.question,
    timeoutMs: options.timeoutMs,
    permissionMode: options.permissionPolicy?.mode,
    sessionRoot: options.permissionPolicy?.root,
    execOverrides: options.permissionPolicy && { mode: options.permissionPolicy.execMode },
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    ...(params.sessionKey && params.storePath
      ? {
          sessionTarget: {
            agentId: params.agentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          },
        }
      : {}),
    ...(params.sandboxSessionKey ? { sandboxSessionKey: params.sandboxSessionKey } : {}),
    agentId: params.agentId,
    ...(params.messageChannel ? { messageChannel: params.messageChannel } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.chatType ? { chatType: params.chatType } : {}),
    ...(params.agentAccountId ? { agentAccountId: params.agentAccountId } : {}),
    ...(params.messageTo ? { messageTo: params.messageTo } : {}),
    ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
    ...(params.chatId ? { chatId: params.chatId } : {}),
    ...(params.messageActionTurnCapability
      ? { messageActionTurnCapability: params.messageActionTurnCapability }
      : {}),
    ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
    ...(params.groupChannel !== undefined ? { groupChannel: params.groupChannel } : {}),
    ...(params.groupSpace !== undefined ? { groupSpace: params.groupSpace } : {}),
    ...(params.memberRoleIds ? { memberRoleIds: params.memberRoleIds } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    ...(params.senderId !== undefined ? { senderId: params.senderId } : {}),
    ...(params.senderName !== undefined ? { senderName: params.senderName } : {}),
    ...(params.senderUsername !== undefined ? { senderUsername: params.senderUsername } : {}),
    ...(params.senderE164 !== undefined ? { senderE164: params.senderE164 } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.currentChannelId ? { currentChannelId: params.currentChannelId } : {}),
    ...(params.toolsAllow ? { toolsAllow: params.toolsAllow } : {}),
    workspaceDir: options.cwd,
    authProfileId: options.authProfileId,
    authProfileIdSource: options.authProfileId
      ? params.preparedRuntimeAuth.plan.forwardedAuthProfileSource
      : undefined,
    thinkLevel: params.resolvedThinkLevel ?? "off",
    resolvedReasoningLevel: params.resolvedReasoningLevel,
    authStorage: params.preparedRuntimeAuth.authStorage,
    authProfileStore: params.preparedRuntimeAuth.authProfileStore,
    modelRegistry: params.preparedRuntimeAuth.modelRegistry,
    preparedModelRuntime: params.preparedModelRuntime,
    ...(params.preparedRuntimeAuth.resolvedApiKey
      ? { resolvedApiKey: params.preparedRuntimeAuth.resolvedApiKey }
      : {}),
    runId: options.runId,
    abortSignal: params.opts?.abortSignal,
    onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
      if (event.stream === "approval") {
        // SAFETY: approval stream payloads are produced by the typed agent event bridge.
        void params.opts?.onApprovalEvent?.(event.data as never);
      }
    },
    onBlockReply: params.opts?.onBlockReply,
    onPartialReply: params.opts?.onPartialReply,
    onToolResult: params.opts?.onToolResult,
    requireExplicitMessageTarget: true,
    hostCapabilities: params.hostCapabilities,
    sandbox: params.sandbox,
  };
  // SAFETY: this builder maps the complete V2 run-attempt contract from the V2 side-question input.
  return sideParams as EmbeddedRunAttemptParamsV2;
}
