/** Builds one canonical requester-origin snapshot for Codex tool hook paths. */
import {
  buildAgentHookContextOriginFields,
  type EmbeddedRunAttemptParams,
  type ToolHookRunContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/** Build the plain run metadata shared by Codex before/after tool hook owners. */
export function buildCodexToolHookRunContext(params: {
  attempt: EmbeddedRunAttemptParams;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
}): ToolHookRunContext {
  const attempt = params.attempt;
  const agentId = params.agentId ?? attempt.agentId;
  const sessionKey = params.sessionKey ?? attempt.sessionKey;
  const sessionId = params.sessionId ?? attempt.sessionId;
  const runId = params.runId ?? attempt.runId;
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(attempt.jobId ? { jobId: attempt.jobId } : {}),
    ...(attempt.trigger ? { trigger: attempt.trigger } : {}),
    ...buildAgentHookContextOriginFields({
      sessionKey,
      messageChannel: attempt.messageChannel,
      messageProvider: attempt.messageProvider ?? attempt.messageChannel,
      currentChannelId: params.channelId ?? attempt.currentChannelId,
      messageTo: attempt.currentMessagingTarget ?? attempt.messageTo,
      trigger: attempt.trigger,
      senderId: attempt.senderId,
      chatId: attempt.chatId,
      channelContext: attempt.channelContext,
    }),
  };
}
