import {
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
  restorePreparedUserTurnOperationalMetaForRuntime,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { withCodexSessionTranscriptMirrorWriteLock } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  publishSessionTranscriptUpdateByIdentity,
  type TranscriptEntryAnchor,
  type SessionTranscriptTargetParams,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexAsyncQuestions } from "./async-questions.js";
import type { AttemptSettlementWarning } from "./attempt-terminal.js";
import {
  applyCodexTranscriptTaint,
  attachCodexMirrorAttestation,
  attachCodexMirrorRunId,
  buildCodexMirrorDedupeIdentity,
  fingerprintCodexMirrorSourceMessage,
  isMirroredAgentMessage,
  type MirroredAgentMessage,
} from "./transcript-mirror-attestation.js";
import { attachCodexMirrorIdentity, readMirrorIdentity } from "./upstream-prompt-provenance.js";

type MirroredUserMessage = Extract<AgentMessage, { role: "user" }>;
export type MirroredUserMessageReceipt = {
  anchor: TranscriptEntryAnchor;
  appended: boolean;
  message: MirroredUserMessage;
};
export type CodexAppServerTranscriptMirrorResult = {
  assistantMirrorIdentitiesOwned: string[];
  anchorsByMirrorIdentity: Map<string, TranscriptEntryAnchor>;
  messagesPresent: MirroredAgentMessage[];
  userMessageReceipts: MirroredUserMessageReceipt[];
};

export function readMirroredAssistantText(
  message: MirroredAgentMessage | undefined,
): string | undefined {
  return message?.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ||
        undefined
    : undefined;
}

export async function mirror(params: {
  assertCurrent?: () => void;
  assertWriteCurrent?: () => void;
  sessionId: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  runId?: string;
  runMirrorIdentityPrefix?: string;
  terminalAssistantOwner?: {
    mirrorIdentity: string;
    runId: string;
    settlementWarning?: AttemptSettlementWarning;
  };
  prepareAssistantTranscriptMessage?: EmbeddedRunAttemptParams["prepareAssistantTranscriptMessage"];
  config?: SessionTranscriptWriteLockParams["config"];
  skipBeforeMessageWriteHooks?: boolean;
}): Promise<CodexAppServerTranscriptMirrorResult> {
  const messages = params.messages.filter(isMirroredAgentMessage);
  if (messages.length === 0) {
    return {
      assistantMirrorIdentitiesOwned: [],
      anchorsByMirrorIdentity: new Map(),
      messagesPresent: [],
      userMessageReceipts: [],
    };
  }

  const candidates = messages.map((message) => {
    const dedupeIdentity = buildCodexMirrorDedupeIdentity(message);
    const sourceFingerprint = fingerprintCodexMirrorSourceMessage(message);
    const sourceUserIdempotencyKey =
      message.role === "user"
        ? normalizeOptionalString("idempotencyKey" in message ? message.idempotencyKey : undefined)
        : undefined;
    // Gateway-owned user keys keep optimistic client rows stable. Other rows use
    // the provider mirror identity so retries find the exact logical message.
    const idempotencyKey =
      sourceUserIdempotencyKey ??
      (params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : undefined);
    return { dedupeIdentity, idempotencyKey, message, sourceFingerprint };
  });
  const candidateIdempotencyKeys = candidates.flatMap(({ idempotencyKey }) =>
    idempotencyKey ? [idempotencyKey] : [],
  );
  const transcriptTarget = resolveCodexMirrorTranscriptTarget(params);
  // A queued terminal must still match its prepared outcome before committing.
  // Publication may trigger Stop afterward; that cannot erase a committed receipt.
  const assertWritable = () => {
    params.assertCurrent?.();
    params.assertWriteCurrent?.();
  };
  assertWritable();
  const mirrorBatch = await withCodexSessionTranscriptMirrorWriteLock(
    { ...transcriptTarget, config: params.config },
    async (transcript) => {
      assertWritable();
      const nextAppendedUpdates: Array<{
        lifecycleRevision?: string;
        messageId: string;
        message: AgentMessage;
        messageSeq?: number;
      }> = [];
      const nextAssistantMirrorIdentitiesOwned = new Set<string>();
      const nextAnchorsByMirrorIdentity = new Map<string, TranscriptEntryAnchor>();
      const nextMessagesPresent: MirroredAgentMessage[] = [];
      const nextUserMessageReceipts: MirroredUserMessageReceipt[] = [];
      const mirrorFacts = await transcript.readMessageFacts({
        idempotencyKeys: candidateIdempotencyKeys,
      });
      assertWritable();
      const taint = { tainted: false };
      for (const { dedupeIdentity, idempotencyKey, message, sourceFingerprint } of candidates) {
        const sourceMessage = applyCodexTranscriptTaint(message, taint);
        const mirrorIdentity = readMirrorIdentity(message);
        const ownsRun = Boolean(
          params.runId &&
          (!params.runMirrorIdentityPrefix ||
            mirrorIdentity?.startsWith(params.runMirrorIdentityPrefix)),
        );
        const terminalOwner = params.terminalAssistantOwner;
        const ownsTerminal = Boolean(
          ownsRun && terminalOwner && mirrorIdentity === terminalOwner.mirrorIdentity,
        );
        const ownedMessage =
          ownsRun && params.runId
            ? attachCodexMirrorRunId(
                sourceMessage,
                params.runId,
                ownsTerminal,
                terminalOwner?.settlementWarning,
              )
            : sourceMessage;
        const transcriptMessage = {
          ...attachCodexMirrorAttestation(ownedMessage, sourceFingerprint),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        if (idempotencyKey && mirrorFacts.existingIdempotencyKeys.has(idempotencyKey)) {
          const persistedMessage = mirrorFacts.messagesByIdempotencyKey.get(idempotencyKey);
          const persistedAnchor = mirrorFacts.anchorsByIdempotencyKey.get(idempotencyKey);
          if (persistedMessage && isMirroredAgentMessage(persistedMessage)) {
            nextMessagesPresent.push(persistedMessage);
            if (persistedMessage.role === "user" && persistedAnchor) {
              nextUserMessageReceipts.push({
                anchor: persistedAnchor,
                appended: false,
                message: persistedMessage,
              });
            }
          }
          if (persistedAnchor) {
            nextAnchorsByMirrorIdentity.set(dedupeIdentity, persistedAnchor);
          }
          if (message.role === "assistant") {
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        assertWritable();
        const preparedUserMessage =
          transcriptMessage.role === "user"
            ? {
                ...transcriptMessage,
                __openclaw: { ...Reflect.get(transcriptMessage, "__openclaw") },
              }
            : undefined;
        if (preparedUserMessage?.["__openclaw"].humanMentions !== undefined) {
          // Hooks cannot move a selection by mutating the original text or spans in place.
          preparedUserMessage.content = structuredClone(preparedUserMessage.content);
          preparedUserMessage["__openclaw"].humanMentions = structuredClone(
            preparedUserMessage["__openclaw"].humanMentions,
          );
        }
        const asyncSourceText =
          message.role === "assistant" && message.openclawAsyncDelivery
            ? readMirroredAssistantText(message)
            : undefined;
        const nextMessage = runAgentHarnessBeforeMessageWriteHook({
          message: transcriptMessage,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          skipBeforeMessageWriteHooks: params.skipBeforeMessageWriteHooks,
          // Only this turn's terminal row belongs to the outer attachment dispatcher.
          prepareAssistantTranscriptMessage: ownsTerminal
            ? params.prepareAssistantTranscriptMessage
            : undefined,
        });
        if (!nextMessage) {
          if (message.role === "assistant") {
            // A transcript hook deliberately blocked this logical assistant row.
            // Treat that as an authoritative persistence decision so delivery
            // does not bypass the hook with a fallback mirror.
            nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
          }
          continue;
        }
        const restoredMessage = restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: nextMessage,
          preparedMessage: preparedUserMessage,
        });
        let messageToAppend = idempotencyKey
          ? {
              ...attachCodexMirrorAttestation(restoredMessage, sourceFingerprint),
              idempotencyKey,
            }
          : attachCodexMirrorAttestation(restoredMessage, sourceFingerprint);
        if (mirrorIdentity) {
          // Hooks may replace the whole message. Restore the provider-owned
          // identity so retries cannot turn a stale idempotency hit into evidence.
          messageToAppend = attachCodexMirrorIdentity(messageToAppend, mirrorIdentity);
        }
        if (ownsRun && params.runId) {
          messageToAppend = attachCodexMirrorRunId(
            messageToAppend,
            params.runId,
            ownsTerminal,
            terminalOwner?.settlementWarning,
          );
        }
        if (message.role === "assistant" && message.openclawAsyncDelivery) {
          // Async delivery ownership is provider-authored. Whole-message hooks may
          // rewrite content, but must not turn the durable row into a terminal answer.
          // Controls must not re-expose source text that a hook rewrote or redacted.
          const questions =
            isMirroredAgentMessage(messageToAppend) &&
            readMirroredAssistantText(messageToAppend) === asyncSourceText
              ? readCodexAsyncQuestions(messageToAppend.openclawAsyncDelivery?.questions)
              : undefined;
          messageToAppend = Object.assign(messageToAppend, {
            openclawAsyncDelivery: {
              itemId: message.openclawAsyncDelivery.itemId,
              ...(questions ? { questions } : {}),
            },
          });
        }
        // Whole-message hooks can replace metadata, but cannot erase source-owned taint.
        messageToAppend = applyCodexTranscriptTaint(messageToAppend, taint);
        messageToAppend = projectAgentHarnessTranscriptMessageForDisplay({
          hidden: message.display === false,
          message: messageToAppend,
        });
        assertWritable();
        const {
          lifecycleRevision,
          messageSeq,
          result: appended,
        } = await transcript.appendMessageWithMessageSequence({
          message: messageToAppend,
          ...(params.assertCurrent || params.assertWriteCurrent
            ? {
                prepareMessageAfterIdempotencyCheck: (preparedMessage: typeof messageToAppend) => {
                  assertWritable();
                  return preparedMessage;
                },
              }
            : {}),
          // Preliminary facts avoid hooks and payload work on normal retries.
          // SQLite repeats this lookup under BEGIN IMMEDIATE for cross-process safety.
          idempotencyLookup: "scan",
          cwd: params.cwd,
        });
        params.assertCurrent?.();
        if (!appended) {
          continue;
        }
        const { messageId, message: appendedMessage } = appended;
        if (isMirroredAgentMessage(appendedMessage)) {
          nextMessagesPresent.push(appendedMessage);
          if (idempotencyKey) {
            mirrorFacts.messagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
          }
        }
        if (message.role === "assistant") {
          nextAssistantMirrorIdentitiesOwned.add(dedupeIdentity);
        }
        if (appended.anchor) {
          nextAnchorsByMirrorIdentity.set(dedupeIdentity, appended.anchor);
        }
        if (appendedMessage.role === "user" && appended.anchor) {
          nextUserMessageReceipts.push({
            anchor: appended.anchor,
            appended: appended.appended,
            message: appendedMessage,
          });
        }
        if (appended.appended) {
          nextAppendedUpdates.push({
            lifecycleRevision,
            messageId,
            message: appendedMessage,
            ...(messageSeq !== undefined ? { messageSeq } : {}),
          });
        }
        if (idempotencyKey) {
          mirrorFacts.existingIdempotencyKeys.add(idempotencyKey);
          if (appended.anchor) {
            mirrorFacts.anchorsByIdempotencyKey.set(idempotencyKey, appended.anchor);
          }
        }
      }
      return {
        appendedUpdates: nextAppendedUpdates,
        assistantMirrorIdentitiesOwned: [...nextAssistantMirrorIdentitiesOwned],
        anchorsByMirrorIdentity: nextAnchorsByMirrorIdentity,
        messagesPresent: nextMessagesPresent,
        userMessageReceipts: nextUserMessageReceipts,
      };
    },
  );
  params.assertCurrent?.();
  const { appendedUpdates, ...result } = mirrorBatch;

  for (const update of appendedUpdates) {
    try {
      // Commentary and tool rows share the Codex turn but cannot claim terminal run ownership.
      const terminalOwner = params.terminalAssistantOwner;
      const terminalRunId =
        update.message.role === "assistant" &&
        terminalOwner &&
        readMirrorIdentity(update.message) === terminalOwner.mirrorIdentity
          ? terminalOwner.runId
          : undefined;
      await publishSessionTranscriptUpdateByIdentity({
        ...transcriptTarget,
        update: {
          lifecycleRevision: update.lifecycleRevision,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          message: update.message,
          messageId: update.messageId,
          ...(update.messageSeq !== undefined ? { messageSeq: update.messageSeq } : {}),
          ...(terminalRunId ? { runId: terminalRunId } : {}),
          sessionKey: transcriptTarget.sessionKey,
        },
      });
    } catch (error) {
      // The transcript append is already committed. A transient live-update
      // failure must not make dispatch append a second assistant message.
      embeddedAgentLog.warn("failed to publish codex app-server transcript update", {
        error: formatErrorMessage(error),
      });
    }
  }

  return result;
}

function resolveCodexMirrorTranscriptTarget(params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): SessionTranscriptTargetParams {
  const sessionKey = params.sessionKey?.trim();
  const storePath = params.storePath?.trim();
  if (!sessionKey || !storePath) {
    throw new Error("Codex transcript mirror requires a runtime session identity");
  }
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey,
    storePath,
  };
}
