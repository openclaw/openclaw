import {
  isExplicitlySilentReplyPayload,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../../auto-reply/reply-payload.js";
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
import type { AgentRunSessionTarget } from "../../run-session-target.types.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";

type PersistHandledBeforeAgentReplyTranscriptParams = {
  assertCurrent: () => void;
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
    assertCurrent: params.assertCurrent,
    beforeMessageWrite: (write) => {
      params.assertCurrent();
      const message = runAgentHarnessBeforeMessageWriteHook({
        ...write,
        prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
      });
      params.assertCurrent();
      return message;
    },
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

async function prepareEmbeddedHandledBeforeAgentReply(
  params: Omit<PersistHandledBeforeAgentReplyTranscriptParams, "text"> & {
    persist: boolean;
    reply?: ReplyPayload;
  },
): Promise<{
  finalText: string;
  payloads: ReplyPayload[];
  persistenceWarning?: string;
}> {
  params.assertCurrent();
  const finalText = params.reply?.text ?? SILENT_REPLY_TOKEN;
  const payloads = buildHandledBeforeAgentReplyPayloads(params.reply);
  const transcriptText = resolveHandledBeforeAgentReplyTranscriptText(params.reply);
  if (
    !params.persist ||
    !params.reply ||
    isExplicitlySilentReplyPayload(params.reply) ||
    transcriptText === null
  ) {
    for (const payload of payloads) {
      setReplyPayloadMetadata(payload, { assistantTranscriptOwned: true });
    }
    return { finalText, payloads };
  }
  const transcript = await persistHandledBeforeAgentReplyTranscript({
    ...params,
    text: transcriptText,
  });
  params.assertCurrent();
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

type EmbeddedHandledBeforeAgentReplyRunParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "config"
  | "currentInboundEventKind"
  | "prepareAssistantTranscriptMessage"
  | "runId"
  | "sessionId"
  | "sessionPersistence"
>;

export async function buildEmbeddedHandledBeforeAgentReplyResult(params: {
  assertCurrent: () => void;
  agentId?: string;
  model: string;
  provider: string;
  redactedSessionId: string;
  reply?: ReplyPayload;
  run: EmbeddedHandledBeforeAgentReplyRunParams;
  sessionKey?: string;
  sessionTarget: AgentRunSessionTarget;
  startedAt: number;
  warn: (message: string) => void;
}) {
  const handled = await prepareEmbeddedHandledBeforeAgentReply({
    assertCurrent: params.assertCurrent,
    agentId: params.agentId,
    config: params.run.config,
    model: params.model,
    persist:
      params.run.sessionPersistence !== "detached" &&
      params.run.currentInboundEventKind !== "room_event",
    prepareAssistantTranscriptMessage: params.run.prepareAssistantTranscriptMessage,
    provider: params.provider,
    reply: params.reply,
    runId: params.run.runId,
    sessionId: params.run.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
  });
  if (handled.persistenceWarning) {
    params.warn(
      `before_agent_reply transcript persistence skipped: runId=${params.run.runId} sessionId=${params.redactedSessionId} reason=${handled.persistenceWarning}`,
    );
  }
  return {
    payloads: handled.payloads,
    meta: {
      durationMs: Date.now() - params.startedAt,
      agentMeta: {
        sessionId: params.run.sessionId,
        provider: params.provider,
        model: params.model,
      },
      finalAssistantVisibleText: handled.finalText,
      finalAssistantRawText: handled.finalText,
    },
  };
}
