import {
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  TranscriptEntryAnchor,
  SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AttemptSettlementWarning, EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAsyncDeliverySettlement } from "./event-projector-options.js";
import type { CodexThread } from "./protocol.js";
import {
  projectBoundedCodexThreadHistory,
  type CodexThreadHistoryImportResult,
} from "./transcript-history-projection.js";
import {
  fingerprintCodexMirrorSourceMessage,
  isMirroredAgentMessage,
  readCodexMirrorSourceFingerprint,
  type MirroredAgentMessage,
} from "./transcript-mirror-attestation.js";
import {
  mirror,
  readMirroredAssistantText,
  type CodexAppServerTranscriptMirrorResult,
  type MirroredUserMessageReceipt,
} from "./transcript-mirror-write.js";
import {
  attachCodexMirrorIdentity,
  attachUpstreamUserText,
  readMirrorIdentity,
} from "./upstream-prompt-provenance.js";
import {
  buildResolvedCodexUserPromptMessage,
  buildCodexUserPromptMessage,
  resolveFinalCodexMirrorMessages,
} from "./user-prompt-message.js";

export { buildCodexUserPromptMessage };
export { projectBoundedCodexThreadHistory };

type UserMessagePersistenceNotifier = (receipt: MirroredUserMessageReceipt) => void;

/** Imports a bounded, user-visible Codex history tail into a new OpenClaw transcript. */
export async function importCodexThreadHistoryToTranscript(params: {
  assertCurrent?: () => void;
  thread: CodexThread;
  throughTurnId: string | null;
  storePath: string;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  cwd?: string;
  modelProvider?: string | null;
  config?: SessionTranscriptWriteLockParams["config"];
}): Promise<CodexThreadHistoryImportResult> {
  const { transcriptMessages, importedMessages, omittedMessages } =
    projectBoundedCodexThreadHistory({
      thread: params.thread,
      throughTurnId: params.throughTurnId,
      importedAt: Date.now(),
      ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
    });
  if (transcriptMessages.length > 0) {
    await mirror({
      assertCurrent: params.assertCurrent,
      storePath: params.storePath,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config } : {}),
      messages: transcriptMessages,
      idempotencyScope: `codex-app-server:${params.thread.id}:history`,
    });
  }
  return { importedMessages, omittedMessages };
}

async function mirrorBestEffort(params: {
  assertWriteCurrent?: () => void;
  settlementWarning?: AttemptSettlementWarning;
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: UserMessagePersistenceNotifier;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<{
  assistantTranscriptOwned: boolean;
  assistantTranscriptIdempotencyKey?: string;
  terminalAnchor?: TranscriptEntryAnchor;
  mirroredMessages: MirroredAgentMessage[];
}> {
  if (!params.params.sessionTarget) {
    return { assistantTranscriptOwned: false, mirroredMessages: [] };
  }
  try {
    const messages = await resolveFinalCodexMirrorMessages({
      params: params.params,
      messagesSnapshot: params.result.messagesSnapshot,
      turnId: params.turnId,
    });
    const recorder = params.params.userTurnTranscriptRecorder;
    const admittedPromptIdentity = recorder?.getAdmissionReceipt()
      ? `${params.turnId}:prompt`
      : undefined;
    const admittedPrompt = admittedPromptIdentity ? recorder?.getPersistedMessage?.() : undefined;
    params.assertWriteCurrent?.();
    const mirrorResult = await mirror({
      assertWriteCurrent: params.assertWriteCurrent,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      storePath: params.params.sessionTarget?.storePath,
      cwd: params.cwd,
      // The host owns admitted user rows. Settlement may reuse their evidence,
      // but must not recreate a removed admission through the generic writer.
      messages: admittedPromptIdentity
        ? messages.filter((message) => readMirrorIdentity(message) !== admittedPromptIdentity)
        : messages,
      // Thread-scoped keys dedupe re-emitted prior-turn messages by their original identity.
      idempotencyScope: `codex-app-server:${params.threadId}`,
      runId: params.params.runId,
      runMirrorIdentityPrefix: `${params.turnId}:`,
      // The outer run may continue a failed attempt. Only its eventual answer
      // may own the final projection, otherwise the client sees two terminal rows.
      terminalAssistantOwner:
        params.params.deferTerminalLifecycle && params.result.terminal.kind === "failed"
          ? undefined
          : {
              mirrorIdentity: `${params.turnId}:assistant`,
              runId: params.params.runId,
              settlementWarning: params.settlementWarning,
            },
      prepareAssistantTranscriptMessage: params.params.prepareAssistantTranscriptMessage,
      config: params.params.config,
    });
    for (const receipt of mirrorResult.userMessageReceipts) {
      try {
        params.notifyUserMessagePersisted(receipt);
      } catch (error) {
        embeddedAgentLog.warn("failed to notify codex app-server user-message persistence", {
          error: formatErrorMessage(error),
        });
      }
    }
    const expectedFingerprints = new Map(
      messages.flatMap((message) => {
        if (!isMirroredAgentMessage(message)) {
          return [];
        }
        const identity = readMirrorIdentity(message);
        return identity ? [[identity, fingerprintCodexMirrorSourceMessage(message)] as const] : [];
      }),
    );
    const mirroredMessages = [
      ...(admittedPrompt ? [admittedPrompt] : []),
      ...mirrorResult.messagesPresent,
    ].filter((message) => {
      const identity = readMirrorIdentity(message);
      const expectedFingerprint = identity ? expectedFingerprints.get(identity) : undefined;
      return (
        expectedFingerprint !== undefined &&
        readCodexMirrorSourceFingerprint(message) === expectedFingerprint
      );
    });
    const assistantMirrorIdentity = `${params.turnId}:assistant`;
    const assistantTranscriptMessage = mirroredMessages.find(
      (message) => readMirrorIdentity(message) === assistantMirrorIdentity,
    );
    const assistantTranscriptOwned = Boolean(
      assistantTranscriptMessage &&
      mirrorResult.assistantMirrorIdentitiesOwned.includes(assistantMirrorIdentity),
    );
    const assistantTranscriptIdempotencyKey = normalizeOptionalString(
      (assistantTranscriptMessage as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
    );
    const terminalMessage = mirroredMessages.at(-1);
    const terminalMirrorIdentity = terminalMessage
      ? readMirrorIdentity(terminalMessage)
      : undefined;
    const terminalAnchor =
      (terminalMirrorIdentity
        ? mirrorResult.anchorsByMirrorIdentity.get(terminalMirrorIdentity)
        : undefined) ?? params.params.userTurnTranscriptRecorder?.getAdmissionReceipt();
    return {
      assistantTranscriptOwned,
      ...(assistantTranscriptIdempotencyKey ? { assistantTranscriptIdempotencyKey } : {}),
      ...(terminalAnchor ? { terminalAnchor } : {}),
      mirroredMessages,
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", {
      error: formatErrorMessage(error),
      runId: params.params.runId,
      sessionId: params.params.sessionId,
    });
    return { assistantTranscriptOwned: false, mirroredMessages: [] };
  }
}

export function createCodexAppServerUserMessagePersistenceNotifier(
  runParams: EmbeddedRunAttemptParams,
): UserMessagePersistenceNotifier {
  let notified = false;
  return (receipt) => {
    if (notified) {
      return;
    }
    notified = true;
    runParams.userTurnTranscriptRecorder?.markRuntimePersisted(
      receipt.message,
      receipt.anchor,
      receipt,
    );
    try {
      runParams.onUserMessagePersisted?.(receipt.message);
    } catch (error) {
      embeddedAgentLog.warn("codex app-server user persistence notification failed", {
        error: formatErrorMessage(error),
      });
    }
  };
}

export async function mirrorPromptAtTurnStartBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  notifyUserMessagePersisted: UserMessagePersistenceNotifier;
  sessionKey?: string;
  cwd: string;
  threadId: string;
  turnId: string;
  upstreamUserText: string;
}): Promise<void> {
  if (params.params.suppressNextUserMessagePersistence || !params.params.sessionTarget) {
    return;
  }
  try {
    const mirrorPromise = (async () => {
      const userPromptMessage = projectAgentHarnessTranscriptMessageForDisplay({
        hidden: params.params.trigger === "memory",
        inputProvenance: params.params.inputProvenance,
        message: attachUpstreamUserText(
          attachCodexMirrorIdentity(
            await buildResolvedCodexUserPromptMessage(params.params),
            `${params.turnId}:prompt`,
          ),
          params.upstreamUserText,
        ),
      });
      const annotate = params.params.hostCapabilities.annotateCurrentUserTurn;
      if (annotate) {
        // Native turn acceptance supplies the identity. Annotate before taking the mirror lock:
        // the anchored writer owns that same queue and must never be nested under it.
        await annotate({
          mirrorIdentity: `${params.turnId}:prompt`,
          upstreamUserText: params.upstreamUserText,
          mirrorOrigin: "codex-app-server",
          mirrorSourceFingerprint: fingerprintCodexMirrorSourceMessage(userPromptMessage),
        });
      }
      const recorder = params.params.userTurnTranscriptRecorder;
      const admission = recorder?.getAdmissionReceipt();
      if (admission) {
        const message = recorder?.getPersistedMessage?.();
        if (message) {
          params.params.hostCapabilities.assertActive();
          params.notifyUserMessagePersisted({ anchor: admission, appended: false, message });
        }
        return;
      }
      const mirrorResult = await mirror({
        assertCurrent: params.params.hostCapabilities.assertActive,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.params.sessionId,
        storePath: params.params.sessionTarget?.storePath,
        cwd: params.cwd,
        messages: [userPromptMessage],
        idempotencyScope: `codex-app-server:${params.threadId}`,
        runId: params.params.runId,
        runMirrorIdentityPrefix: `${params.turnId}:`,
        config: params.params.config,
      });
      for (const receipt of mirrorResult.userMessageReceipts) {
        params.notifyUserMessagePersisted(receipt);
      }
    })();
    params.params.userTurnTranscriptRecorder?.markRuntimePersistencePending(mirrorPromise);
    await mirrorPromise;
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server prompt at turn start", {
      error: formatErrorMessage(error),
      runId: params.params.runId,
      sessionId: params.params.sessionId,
    });
  }
}

async function deliverAsyncMessageBestEffort(params: {
  cwd: string;
  params: EmbeddedRunAttemptParams;
  itemId: string;
  message: AgentMessage;
  text: string;
  threadId: string;
  turnId: string;
}): Promise<CodexAsyncDeliverySettlement> {
  const mirrorIdentity = `${params.turnId}:async:${params.itemId}`;
  const deliveryIntentId = `block-reply:v1:codex-app-server:${[
    params.threadId,
    params.turnId,
    params.itemId,
  ]
    .map(encodeURIComponent)
    .join(":")}`;
  const target = params.params.sessionTarget;
  let text: string | undefined;
  if (target) {
    let result: CodexAppServerTranscriptMirrorResult;
    try {
      result = await mirror({
        agentId: target.agentId ?? params.params.agentId,
        sessionId: target.sessionId ?? params.params.sessionId,
        sessionKey: target.sessionKey ?? params.params.sessionKey,
        storePath: target.storePath,
        cwd: params.cwd,
        config: params.params.config,
        messages: [attachCodexMirrorIdentity(params.message, mirrorIdentity)],
        idempotencyScope: `codex-app-server:${params.threadId}`,
        runId: params.params.runId,
        runMirrorIdentityPrefix: `${params.turnId}:`,
      });
    } catch (error) {
      embeddedAgentLog.warn("failed to persist codex async agent message", {
        error: formatErrorMessage(error),
        itemId: params.itemId,
        runId: params.params.runId,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      return "retry";
    }

    if (!result.assistantMirrorIdentitiesOwned.includes(mirrorIdentity)) {
      return "retry";
    }
    text = readMirroredAssistantText(
      result.messagesPresent.find((message) => readMirrorIdentity(message) === mirrorIdentity),
    );
  } else {
    if (!params.params.onBlockReply) {
      return "retry";
    }
    text = params.text;
  }

  if (params.params.onBlockReply && text !== undefined) {
    try {
      await deliverAsyncBlockReply(params.params.onBlockReply, text, deliveryIntentId);
    } catch (error) {
      embeddedAgentLog.warn(
        target
          ? "failed to deliver persisted codex async agent message"
          : "failed to deliver codex async agent message",
        {
          error: formatErrorMessage(error),
          itemId: params.itemId,
          runId: params.params.runId,
          threadId: params.threadId,
          turnId: params.turnId,
        },
      );
      return "retry";
    }
  }
  return "settled";
}

export const codexTranscriptMirrorRuntime = {
  deliverAsyncMessageBestEffort,
  mirror,
  mirrorBestEffort,
};

async function deliverAsyncBlockReply(
  onBlockReply: NonNullable<EmbeddedRunAttemptParams["onBlockReply"]>,
  text: string,
  deliveryIntentId: string,
): Promise<void> {
  // Harness-owned prompts already carry the host's canonical source-delivery
  // authorization; an empty question list keeps the upstream message exact.
  await deliverAgentHarnessUserInputPrompt(
    { onBlockReply: (payload) => onBlockReply(payload, { deliveryIntentId }) },
    [],
    { intro: text },
  );
}
