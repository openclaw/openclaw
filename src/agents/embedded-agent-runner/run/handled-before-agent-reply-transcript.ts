import { setReplyPayloadMetadata, type ReplyPayload } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { PrepareAssistantTranscriptMessage } from "../../../config/sessions/transcript-assistant-delivery.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAppendResult,
} from "../../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  resolveHandledBeforeAgentReplyTranscriptText,
} from "../../../plugins/before-agent-reply.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../harness/hook-helpers.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";

type PersistHandledBeforeAgentReplyTranscriptParams = {
  agentId?: string;
  config?: OpenClawConfig;
  model: string;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  provider: string;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget: AgentRunSessionTarget;
  text: string;
};

/** Persists a hook-owned assistant turn before the embedded attempt/session manager exists. */
async function persistHandledBeforeAgentReplyTranscript(
  params: PersistHandledBeforeAgentReplyTranscriptParams,
): Promise<SessionTranscriptAppendResult & { idempotencyKey?: string }> {
  const sessionKey = params.sessionTarget.sessionKey ?? params.sessionKey;
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  const sessionId = params.sessionTarget.sessionId ?? params.sessionId;
  const idempotencyKey = `before-agent-reply:${params.runId}`;
  const result = await appendExactAssistantMessageToSessionTranscript({
    agentId: params.sessionTarget.agentId ?? params.agentId,
    sessionKey,
    expectedSessionId: sessionId,
    ...(params.sessionTarget.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: params.sessionTarget.expectedLifecycleRevision }
      : {}),
    ...(params.sessionTarget.expectedWriterRunId !== undefined
      ? { expectedWriterRunId: params.sessionTarget.expectedWriterRunId }
      : {}),
    storePath: params.sessionTarget.storePath,
    config: params.config,
    runId: params.runId,
    idempotencyKey,
    beforeMessageWrite: (write) =>
      runAgentHarnessBeforeMessageWriteHook({
        ...write,
        prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
      }),
    message: buildAssistantMessage({
      model: {
        api: params.provider,
        provider: params.provider,
        id: params.model,
      },
      content: [{ type: "text", text: params.text }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    }),
  });
  return result.ok ? { ...result, idempotencyKey } : result;
}

export async function prepareEmbeddedHandledBeforeAgentReply(
  params: Omit<PersistHandledBeforeAgentReplyTranscriptParams, "text"> & {
    persist: boolean;
    reply?: ReplyPayload;
  },
): Promise<{
  finalText: string;
  payloads: ReplyPayload[];
  persistenceWarning?: string;
}> {
  const finalText = params.reply?.text ?? SILENT_REPLY_TOKEN;
  const payloads = buildHandledBeforeAgentReplyPayloads(params.reply);
  if (!params.persist) {
    return { finalText, payloads };
  }
  const transcript = await persistHandledBeforeAgentReplyTranscript({
    ...params,
    text: resolveHandledBeforeAgentReplyTranscriptText(params.reply),
  });
  if (transcript.ok || transcript.code === "blocked" || transcript.code === "session-rebound") {
    for (const payload of payloads) {
      setReplyPayloadMetadata(payload, {
        assistantTranscriptOwned: true,
        ...(transcript.idempotencyKey
          ? { assistantTranscriptIdempotencyKey: transcript.idempotencyKey }
          : {}),
      });
    }
  }
  return {
    finalText,
    payloads,
    ...(!transcript.ok ? { persistenceWarning: transcript.reason } : {}),
  };
}
