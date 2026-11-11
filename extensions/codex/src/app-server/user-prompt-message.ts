import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { projectAgentHarnessTranscriptMessageForDisplay } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
  readUpstreamUserText,
} from "./upstream-prompt-provenance.js";

type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;

function buildFromPrepared(
  params: EmbeddedRunAttemptParams,
  preparedUserMessage: MirroredUserMessage | undefined,
): MirroredUserMessage {
  const senderId = normalizeOptionalString(params.senderId);
  const senderName = normalizeOptionalString(params.senderName);
  const senderUsername = normalizeOptionalString(params.senderUsername);
  const senderE164 = normalizeOptionalString(params.senderE164);
  const label = senderName ?? senderUsername ?? senderE164 ?? senderId;
  const senderLabel =
    label && senderId && !label.includes(senderId) ? `${label} (${senderId})` : label;
  const sourceChannel = normalizeOptionalString(
    params.inputProvenance?.sourceChannel ?? params.messageChannel ?? params.messageProvider,
  );
  const metadata = {
    timestamp: Date.now(),
    ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderE164 ? { senderE164 } : {}),
    ...(senderLabel ? { senderLabel } : {}),
  };
  return {
    role: "user",
    ...metadata,
    ...(preparedUserMessage ?? { content: params.transcriptPrompt ?? params.prompt }),
  };
}

export function buildCodexUserPromptMessage(params: EmbeddedRunAttemptParams): MirroredUserMessage {
  return buildFromPrepared(params, params.userTurnTranscriptRecorder?.message);
}

export function promptSnapshot(
  params: EmbeddedRunAttemptParams,
  turnId: string,
  upstreamUserText?: string,
): AgentMessage[] {
  if (params.suppressNextUserMessagePersistence) {
    return [];
  }
  const message = attachCodexMirrorIdentity(
    buildCodexUserPromptMessage(params),
    `${turnId}:prompt`,
  );
  return [upstreamUserText ? attachUpstreamUserText(message, upstreamUserText) : message];
}

export async function buildResolvedCodexUserPromptMessage(
  params: EmbeddedRunAttemptParams,
): Promise<MirroredUserMessage> {
  const recorder = params.userTurnTranscriptRecorder;
  const resolvedMessage = recorder?.getPersistedMessage?.() ?? (await recorder?.resolveMessage());
  return buildFromPrepared(params, resolvedMessage ?? recorder?.message);
}

export async function resolveFinalCodexMirrorMessages(params: {
  params: EmbeddedRunAttemptParams;
  messagesSnapshot: AgentMessage[];
  turnId: string;
}): Promise<AgentMessage[]> {
  if (
    params.params.suppressNextUserMessagePersistence ||
    !params.params.userTurnTranscriptRecorder
  ) {
    return params.messagesSnapshot;
  }
  const previousPrompt = params.messagesSnapshot.find((message) => message.role === "user");
  const resolvedBase = attachCodexMirrorIdentity(
    await buildResolvedCodexUserPromptMessage(params.params),
    `${params.turnId}:prompt`,
  );
  const upstreamUserText = readUpstreamUserText(previousPrompt);
  const resolvedPrompt = upstreamUserText
    ? attachUpstreamUserText(resolvedBase, upstreamUserText)
    : resolvedBase;
  const firstUserIndex = params.messagesSnapshot.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) {
    return [resolvedPrompt, ...params.messagesSnapshot];
  }
  const messages = params.messagesSnapshot.slice();
  messages[firstUserIndex] = resolvedPrompt;
  return messages;
}

/** Restore host-persisted input to observers without adding a second transcript write. */
export function buildCodexAgentEndMessages(
  params: EmbeddedRunAttemptParams,
  messagesSnapshot: AgentMessage[],
  turnId?: string,
): AgentMessage[] {
  if (!params.suppressNextUserMessagePersistence || !params.userTurnTranscriptRecorder) {
    return messagesSnapshot;
  }
  const persisted = params.userTurnTranscriptRecorder.getPersistedMessage?.();
  if (!persisted) {
    return messagesSnapshot;
  }
  const promptMirrorIdentity = turnId ? `${turnId}:prompt` : undefined;
  const persistedAlreadyObserved = messagesSnapshot.some((message) => {
    if (message.role !== "user") {
      return false;
    }
    const messageIdempotencyKey = asOptionalRecord(message)?.idempotencyKey;
    return (
      (typeof messageIdempotencyKey === "string" &&
        persisted.idempotencyKey !== undefined &&
        messageIdempotencyKey === persisted.idempotencyKey) ||
      (promptMirrorIdentity !== undefined && readMirrorIdentity(message) === promptMirrorIdentity)
    );
  });
  if (persistedAlreadyObserved) {
    return messagesSnapshot;
  }
  return [
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: params.privateCompletion === true || params.trigger === "memory",
      inputProvenance: params.inputProvenance,
      message: persisted,
    }),
    ...messagesSnapshot,
  ];
}
