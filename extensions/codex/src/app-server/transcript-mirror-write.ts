import {
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
  restorePreparedUserTurnOperationalMetaForRuntime,
  runAgentHarnessBeforeMessageWriteHook,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { withCodexSessionTranscriptMirrorWrite } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  composeSessionTranscriptWriteAssertion,
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
  buildCodexMirrorIdempotencyKey,
  fingerprintCodexMirrorSourceMessage,
  isMirroredAgentMessage,
  readCodexMirrorSourceFingerprint,
  type MirroredAgentMessage,
} from "./transcript-mirror-attestation.js";
import {
  attachCodexMirrorIdentity,
  readMirrorIdentity,
  takeCodexAssistantItemIds,
} from "./upstream-prompt-provenance.js";

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
  onAssistantMessageOwned?: (mirrorIdentity: string) => void;
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

  const candidates = messages.map((source) => {
    const message = { ...source };
    const assistantItemIds = takeCodexAssistantItemIds(message);
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
      (params.idempotencyScope
        ? buildCodexMirrorIdempotencyKey(params.idempotencyScope, dedupeIdentity)
        : undefined);
    return { dedupeIdentity, idempotencyKey, message, sourceFingerprint, assistantItemIds };
  });
  const candidateIdempotencyKeys = candidates.flatMap(({ idempotencyKey }) =>
    idempotencyKey ? [idempotencyKey] : [],
  );
  const transcriptTarget = resolveCodexMirrorTranscriptTarget(params);
  const publishCommitted = async (update: {
    lifecycleRevision?: string;
    messageId: string;
    message: AgentMessage;
    messageSeq?: number;
    assistantItemIds?: readonly string[];
  }) => {
    try {
      // Commentary and tool rows share the turn but cannot claim terminal ownership.
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
          ...update,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(terminalRunId ? { runId: terminalRunId } : {}),
          sessionKey: transcriptTarget.sessionKey,
        },
      });
    } catch (error) {
      // A failed notification cannot turn a committed row into a retryable write.
      embeddedAgentLog.warn("failed to publish codex app-server transcript update", {
        error: formatErrorMessage(error),
      });
    }
  };
  // A queued terminal must still match its prepared outcome before committing.
  // Publication may trigger Stop afterward; that cannot erase a committed receipt.
  const assertWritable = composeSessionTranscriptWriteAssertion([
    params.assertCurrent,
    params.assertWriteCurrent,
  ]);
  assertWritable();
  const result = await withCodexSessionTranscriptMirrorWrite(
    {
      ...transcriptTarget,
      config: params.config,
      ...(params.assertCurrent || params.assertWriteCurrent
        ? { assertCurrent: assertWritable }
        : {}),
    },
    async (transcript) => {
      assertWritable();
      const nextAssistantMirrorIdentitiesOwned = new Set<string>();
      const recordAssistantOwnership = (identity: string) => {
        nextAssistantMirrorIdentitiesOwned.add(identity);
        params.onAssistantMessageOwned?.(identity);
      };
      const nextAnchorsByMirrorIdentity = new Map<string, TranscriptEntryAnchor>();
      const nextMessagesPresent: MirroredAgentMessage[] = [];
      const nextUserMessageReceipts: MirroredUserMessageReceipt[] = [];
      const mirrorFacts = await transcript.readMessageFacts({
        idempotencyKeys: candidateIdempotencyKeys,
      });
      assertWritable();
      const taint = { tainted: false };
      for (const {
        dedupeIdentity,
        idempotencyKey,
        message,
        sourceFingerprint,
        assistantItemIds,
      } of candidates) {
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
        const withRunOwnership = (candidate: AgentMessage) =>
          ownsRun && params.runId
            ? attachCodexMirrorRunId(
                candidate,
                params.runId,
                ownsTerminal,
                terminalOwner?.settlementWarning,
              )
            : candidate;
        const withAttestation = (candidate: AgentMessage) => ({
          ...attachCodexMirrorAttestation(candidate, sourceFingerprint),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        const transcriptMessage = withAttestation(withRunOwnership(sourceMessage));
        if (idempotencyKey && mirrorFacts.existingIdempotencyKeys.has(idempotencyKey)) {
          const persistedMessage = mirrorFacts.messagesByIdempotencyKey.get(idempotencyKey);
          const persistedAnchor = mirrorFacts.anchorsByIdempotencyKey.get(idempotencyKey);
          if (persistedMessage && isMirroredAgentMessage(persistedMessage)) {
            nextMessagesPresent.push(persistedMessage);
            if (
              assistantItemIds &&
              persistedAnchor &&
              readCodexMirrorSourceFingerprint(persistedMessage) === sourceFingerprint
            ) {
              await publishCommitted({
                messageId: persistedAnchor.entryId,
                messageSeq: persistedAnchor.activeMessagePosition + 1,
                message: persistedMessage,
                assistantItemIds,
              });
            }
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
            recordAssistantOwnership(dedupeIdentity);
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
            recordAssistantOwnership(dedupeIdentity);
          }
          continue;
        }
        const restoredMessage = restorePreparedUserTurnOperationalMetaForRuntime({
          runtimeMessage: nextMessage,
          preparedMessage: preparedUserMessage,
        });
        let messageToAppend = withAttestation(restoredMessage);
        if (mirrorIdentity) {
          // Hooks may replace the whole message. Restore the provider-owned
          // identity so retries cannot turn a stale idempotency hit into evidence.
          messageToAppend = attachCodexMirrorIdentity(messageToAppend, mirrorIdentity);
        }
        messageToAppend = withRunOwnership(messageToAppend);
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
          // Preliminary facts avoid hooks and payload work on normal retries.
          // SQLite repeats this lookup under BEGIN IMMEDIATE for cross-process safety.
          idempotencyLookup: "scan",
          cwd: params.cwd,
        });
        // A committed candidate remains owned even if the post-write authority check fails.
        if (appended && message.role === "assistant") {
          recordAssistantOwnership(dedupeIdentity);
        }
        if (!appended) {
          params.assertCurrent?.();
          continue;
        }
        const { messageId, message: appendedMessage } = appended;
        if (isMirroredAgentMessage(appendedMessage)) {
          nextMessagesPresent.push(appendedMessage);
          if (idempotencyKey) {
            mirrorFacts.messagesByIdempotencyKey.set(idempotencyKey, appendedMessage);
          }
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
        const committedItemIds =
          isMirroredAgentMessage(appendedMessage) &&
          readCodexMirrorSourceFingerprint(appendedMessage) === sourceFingerprint
            ? assistantItemIds
            : undefined;
        if (appended.appended || committedItemIds) {
          await publishCommitted({
            lifecycleRevision,
            messageId,
            message: appendedMessage,
            ...(messageSeq !== undefined ? { messageSeq } : {}),
            ...(committedItemIds ? { assistantItemIds: committedItemIds } : {}),
          });
        }
        params.assertCurrent?.();
        if (idempotencyKey) {
          mirrorFacts.existingIdempotencyKeys.add(idempotencyKey);
          if (appended.anchor) {
            mirrorFacts.anchorsByIdempotencyKey.set(idempotencyKey, appended.anchor);
          }
        }
      }
      return {
        assistantMirrorIdentitiesOwned: [...nextAssistantMirrorIdentitiesOwned],
        anchorsByMirrorIdentity: nextAnchorsByMirrorIdentity,
        messagesPresent: nextMessagesPresent,
        userMessageReceipts: nextUserMessageReceipts,
      };
    },
  );
  params.assertCurrent?.();
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
