import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  restorePreparedUserTurnOperationalMetaForRuntime,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptTargetParams,
  type TranscriptEntryAnchor,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isActiveTurnTainted,
  isAttemptTranscriptMessage,
  isCompatibleSingletonRewrite,
  isCompleteToolGroup,
  isCurrentJournalIdentity,
  isSameUserTurn,
  projectReplayPayload,
  readIdempotencyKey,
  readTurnTaintMetadata,
  userText,
  withAssistantTurnTaint,
  type AttemptTranscriptMessage as TranscriptMessage,
} from "./attempt-transcript-replay.js";
import {
  createProviderTerminalJournalLifecycle,
  createTranscriptReceiptRegistry,
  drainScheduledJournalQueue,
} from "./attempt-transcript-terminal.js";
import { assertCopilotAttemptHostCapabilities, type AttemptParamsLike } from "./attempt-types.js";

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
type AppendResult =
  | {
      anchor: TranscriptEntryAnchor;
      appended: boolean;
      message: TranscriptMessage;
    }
  | undefined;
type PendingWrite = {
  eventId?: string;
  message: TranscriptMessage;
  recorder?: TranscriptRecorder;
};
type ToolGroup = {
  assistant: PendingWrite;
  assistantKey: string;
  order: string[];
  results: Map<string, PendingWrite>;
};
type PersistenceReceipt = ReturnType<typeof createDeferred<void>>;

export type AttemptTranscriptJournal = ReturnType<typeof createAttemptTranscriptJournal>;

export function createAttemptTranscriptJournal(params: {
  abortSession: () => Promise<void>;
  attempt: AttemptParamsLike;
  messages: AgentMessage[];
  onInitialSdkUserValidated?: () => void;
  sdkSessionId: string;
}) {
  const hiddenTurn = params.attempt.trigger === "memory";
  const projectDisplay = (message: AgentMessage) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: hiddenTurn || (message as { display?: boolean }).display === false,
      message,
    });
  const messagesSnapshot = [...params.messages];
  let turnTainted = isActiveTurnTainted(messagesSnapshot);
  const snapshotIdempotencyKeys = new Set(
    messagesSnapshot.flatMap((message) => {
      const key = readIdempotencyKey(message);
      return key && isCurrentJournalIdentity(key, params) ? [key] : [];
    }),
  );
  const replaceTailUser = (
    current: Extract<AgentMessage, { role: "user" }> | undefined,
    next?: AgentMessage,
  ) => {
    if (isSameUserTurn(messagesSnapshot.at(-1), current, `${params.attempt.runId}:user`)) {
      const removed = messagesSnapshot.pop();
      const removedKey = removed ? readIdempotencyKey(removed) : undefined;
      if (removedKey && isCurrentJournalIdentity(removedKey, params)) {
        snapshotIdempotencyKeys.delete(removedKey);
      }
    }
    if (next) {
      messagesSnapshot.push(next);
      const nextKey = readIdempotencyKey(next);
      if (nextKey && isCurrentJournalIdentity(nextKey, params)) {
        snapshotIdempotencyKeys.add(nextKey);
      }
    }
  };
  // Missing host recorders fail closed; the journal never reconstructs a prompt string.
  const currentUser = params.attempt.userTurnTranscriptRecorder?.message;
  if (currentUser) {
    replaceTailUser(currentUser, projectDisplay(currentUser));
  }
  const target = resolveTranscriptTarget(params.attempt);
  const config = params.attempt.config;
  const seenEventIds = new Set<string>();
  let pendingTools: ToolGroup | undefined;
  let queue = Promise.resolve();
  let firstFailure: Error | undefined;
  const providerToolReceipts = new Map<string, PersistenceReceipt>();
  const abandonedToolCallIds = new Set<string>();
  const sdkUserPersistenceReceipts = createTranscriptReceiptRegistry(() => firstFailure);
  const sdkUserRecorders = new Map<string, TranscriptRecorder>();
  let abortPromise: Promise<void> | undefined;
  let replayInvalid = false;
  let initialSdkUserObserved = false;
  let initialSdkUserValidated = false;
  let persistedInitialUser: Extract<AgentMessage, { role: "user" }> | undefined;
  let latestAssistantKey: string | undefined;
  let assistantTranscriptOwned = false;
  let assistantTranscriptIdempotencyKey: string | undefined;
  let terminalAnchor: TranscriptEntryAnchor | undefined;

  const snapshotReplayPayload = (message: TranscriptMessage) =>
    structuredClone(projectReplayPayload(message));
  const compareReplayPayloads = (
    expected: readonly unknown[],
    messages: readonly TranscriptMessage[],
  ) => {
    if (
      expected.length !== messages.length ||
      expected.some(
        (payload, index) => !isDeepStrictEqual(payload, projectReplayPayload(messages[index]!)),
      )
    ) {
      replayInvalid = true;
    }
  };

  const captureFailure = (error: unknown) => {
    const fresh = !firstFailure;
    firstFailure ??= error instanceof Error ? error : new Error(String(error));
    providerToolReceipts.forEach((receipt) => receipt.reject(firstFailure!));
    if (!fresh) {
      return;
    }
    replayInvalid = true;
    pendingTools = undefined;
    sdkUserPersistenceReceipts.rejectAll(firstFailure);
    abortPromise = params.abortSession().catch(() => undefined);
  };
  const sdkUserPersistenceReceipt = sdkUserPersistenceReceipts.get;
  const claim = (eventId: string) =>
    !firstFailure && !seenEventIds.has(eventId) && Boolean(seenEventIds.add(eventId));

  const schedule = (task: () => Promise<void> | void) => {
    if (firstFailure) {
      return;
    }
    // SQLite closes SDK checkpoint races inside groups; crashes retain a valid prefix.
    queue = queue.then(() => (firstFailure ? undefined : task())).catch(captureFailure);
  };

  const prepare = (
    write: PendingWrite,
    options: { singleton?: boolean } = {},
  ): TranscriptMessage | undefined => {
    const message = structuredClone(write.message) as TranscriptMessage;
    const originalReplayPayload = snapshotReplayPayload(message);
    const hooked = runAgentHarnessBeforeMessageWriteHook({
      message: structuredClone(message) as TranscriptMessage,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      // Tool-group narrative is replay state, not the dispatcher's terminal attachment reply.
      prepareAssistantTranscriptMessage:
        options.singleton && !hiddenTurn
          ? params.attempt.prepareAssistantTranscriptMessage
          : undefined,
    });
    if (!hooked) {
      return undefined;
    }
    compareReplayPayloads([originalReplayPayload], [hooked as TranscriptMessage]);
    const idempotencyKey = (message as { idempotencyKey?: string }).idempotencyKey;
    const taintMetadata = readTurnTaintMetadata(message);
    const toolIdentity =
      message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : {};
    const projected = projectDisplay({
      ...hooked,
      ...toolIdentity,
      ...(taintMetadata
        ? { __openclaw: { ...readTurnTaintMetadata(hooked), ...taintMetadata } }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(message.role === "user" && message.provenance ? { provenance: message.provenance } : {}),
      ...((message as { display?: boolean }).display === false ? { display: false } : {}),
    }) as TranscriptMessage;
    const prepared =
      message.role === "user"
        ? restorePreparedUserTurnOperationalMetaForRuntime({
            runtimeMessage: projected,
            preparedMessage: message,
          })
        : projected;
    return options.singleton && !isCompatibleSingletonRewrite(message, prepared)
      ? undefined
      : prepared;
  };

  const append = async (write: PendingWrite): Promise<AppendResult> => {
    const originalReplayPayload = snapshotReplayPayload(write.message);
    const outcome = await appendSessionTranscriptMessageByIdentityStrict({
      ...target,
      ...(config ? { config } : {}),
      ...(write.eventId ? { eventId: write.eventId } : {}),
      idempotencyLookup: "scan",
      message: write.message,
      prepareMessageAfterIdempotencyCheck: () => prepare(write, { singleton: true }),
    });
    if (outcome.kind === "suppressed") {
      write.recorder?.markBlocked();
      return undefined;
    }
    if (outcome.kind === "rejected") {
      throw new Error("Transcript session changed before singleton append");
    }
    if (!isAttemptTranscriptMessage(outcome.result.message)) {
      throw new Error("Copilot transcript replayed an invalid message");
    }
    compareReplayPayloads([originalReplayPayload], [outcome.result.message as TranscriptMessage]);
    if (outcome.result.message.role === "user") {
      write.recorder?.markRuntimePersisted(outcome.result.message, outcome.result.anchor, {
        appended: outcome.result.appended,
      });
    }
    return outcome.result as AppendResult;
  };

  const appendToolGroup = async (group: ToolGroup) => {
    const writes = [group.assistant, ...group.order.map((id) => group.results.get(id)!)];
    const originalReplayPayloads = writes.map((write) => snapshotReplayPayload(write.message));
    if (group.order.some((id) => providerToolReceipts.has(id))) {
      assertCopilotAttemptHostCapabilities(params.attempt);
      const commitProviderTranscriptPrefix =
        params.attempt.hostCapabilities.commitProviderTranscriptPrefix;
      if (!commitProviderTranscriptPrefix) {
        throw new Error("provider transcript commit requires host transcript capability");
      }
      const assertCurrent = () => {
        if (firstFailure || pendingTools !== group) {
          throw new Error("Copilot provider transcript group is no longer current");
        }
      };
      const outcome = await commitProviderTranscriptPrefix({
        assertCurrent,
        baseAnchor: terminalAnchor,
        entries: writes.map((write) => ({
          eventId: write.eventId!,
          identity: readIdempotencyKey(write.message)!,
          message: write.message,
        })),
        validatePreparedPrefix: (messages) => {
          const transcriptMessages = messages.filter(isAttemptTranscriptMessage);
          return (
            transcriptMessages.length === messages.length &&
            isCompleteToolGroup(transcriptMessages, group.order)
          );
        },
      });
      if (outcome.kind === "suppressed") {
        return undefined;
      }
      if (outcome.kind !== "committed" && outcome.kind !== "replayed") {
        throw new Error(`Copilot provider transcript commit ${outcome.kind}`);
      }
      if (outcome.results.some((result) => !isAttemptTranscriptMessage(result.message))) {
        throw new Error("Copilot provider transcript replayed an invalid message");
      }
      const results = outcome.results.map((result) => ({
        anchor: result.anchor,
        appended: outcome.kind === "committed",
        message: result.message as TranscriptMessage,
      }));
      compareReplayPayloads(
        originalReplayPayloads,
        results.map((result) => result.message),
      );
      return results;
    }
    const keys = writes.map((write) => readIdempotencyKey(write.message));
    const persistedKeys = new Set(
      (await readVisibleSessionTranscriptMessageEntries(target)).flatMap((entry) =>
        entry.idempotencyKey ? [entry.idempotencyKey] : [],
      ),
    );
    const persistedCount = keys.filter((key) => key && persistedKeys.has(key)).length;
    if (persistedCount > 0 && persistedCount < writes.length) {
      // The pre-atomic journal was never shipped. Partial identity is corruption,
      // not a runtime compatibility shape; recovery stays fail-closed.
      throw new Error("Copilot transcript found a partial persisted tool group");
    }
    // Hooks must finish before BEGIN. This skips steady-state replay hooks; the
    // transaction still revalidates all identities against cross-process races.
    const messages =
      persistedCount === writes.length
        ? writes.map((write) => write.message)
        : writes.map((write) => prepare(write));
    // Hook omission belongs to policy, but the journal owns structure: one block or
    // structurally destructive rewrite suppresses the complete assistant/result group.
    if (
      messages.some((message) => !message) ||
      !isCompleteToolGroup(messages as TranscriptMessage[], group.order)
    ) {
      return undefined;
    }
    const results = await appendSessionTranscriptMessagesByIdentity({
      ...target,
      ...(config ? { config } : {}),
      messages: writes.map((write, index) => ({
        eventId: write.eventId!,
        idempotencyLookup: "scan" as const,
        message: messages[index]!,
      })),
    });
    if (
      !isCompleteToolGroup(
        results.map((result) => result.message),
        group.order,
      )
    ) {
      throw new Error("Copilot transcript replayed an invalid tool group");
    }
    compareReplayPayloads(
      originalReplayPayloads,
      results.map((result) => result.message as TranscriptMessage),
    );
    return results;
  };

  const publish = async (appended: boolean) => {
    if (appended) {
      await publishSessionTranscriptUpdateByIdentity({ ...target }).catch((error: unknown) => {
        console.warn("[copilot-attempt] transcript update notification failed", error);
      });
    }
  };

  const accept = (result: AppendResult): boolean => {
    if (!result) {
      return false;
    }
    const key = readIdempotencyKey(result.message);
    const snapshotKey = key && isCurrentJournalIdentity(key, params) ? key : undefined;
    if (!snapshotKey || !snapshotIdempotencyKeys.has(snapshotKey)) {
      messagesSnapshot.push(result.message);
      if (snapshotKey) {
        snapshotIdempotencyKeys.add(snapshotKey);
      }
    }
    return result.appended;
  };
  const ownAssistant = (key: string, persisted: boolean, anchor?: TranscriptEntryAnchor) => {
    if (latestAssistantKey === key) {
      assistantTranscriptOwned = true;
      assistantTranscriptIdempotencyKey = persisted ? key : undefined;
      terminalAnchor = persisted ? anchor : undefined;
    }
  };
  const drainQueue = (onDrained?: () => void) => drainScheduledJournalQueue(() => queue, onDrained);
  const providerTerminal = createProviderTerminalJournalLifecycle<PendingWrite, AppendResult>({
    abandonPendingTools: () => {
      if (!pendingTools) {
        return;
      }
      for (const toolCallId of pendingTools.order) {
        abandonedToolCallIds.add(toolCallId);
        providerToolReceipts.get(toolCallId)?.resolve();
      }
      pendingTools = undefined;
    },
    accept,
    append,
    drainQueue,
    markReplayInvalid: () => {
      replayInvalid = true;
    },
    publish,
    receiptForEvent: sdkUserPersistenceReceipt,
    rejectUnsettledEvent: (eventId, error) => {
      sdkUserPersistenceReceipt(eventId).reject(error);
      sdkUserRecorders.delete(eventId);
    },
  });
  const finishToolGroup = async (group: ToolGroup) => {
    const providerWrites = group.order.filter((id) => providerToolReceipts.has(id));
    const results = await appendToolGroup(group);
    if (!results && providerWrites.length > 0) {
      throw new Error("Copilot provider transcript group was suppressed");
    }
    let appended = false;
    if (!results) {
      replayInvalid = true;
      ownAssistant(group.assistantKey, false);
    } else {
      for (const result of results) {
        appended = accept(result as AppendResult) || appended;
      }
      ownAssistant(group.assistantKey, true, results.at(-1)?.anchor);
      for (const toolCallId of providerWrites) {
        providerToolReceipts.get(toolCallId)!.resolve();
      }
    }
    pendingTools = undefined;
    const deferred = await providerTerminal.flushDeferred();
    await publish(deferred.appended || appended);
    for (const receipt of deferred.persistedReceipts) {
      receipt.resolve();
    }
  };

  const barrier = async (boundary: string) => {
    await drainQueue();
    if (!firstFailure) {
      // Give an already-delivered SDK event one microtask turn to reach the
      // bridge, then re-drain without another yield before returning.
      await Promise.resolve();
      await drainQueue();
    }
    if (!firstFailure && pendingTools) {
      captureFailure(
        new Error(
          `Copilot transcript reached ${boundary} with unresolved tool results: ${pendingTools.order.join(", ")}`,
        ),
      );
    }
    if (abortPromise) {
      await abortPromise;
    }
    if (firstFailure) {
      const error = new Error(
        `[copilot-attempt] canonical transcript persistence failed: ${firstFailure.message}`,
        { cause: firstFailure },
      ) as Error & { code?: string };
      error.code = "transcript_persistence_failed";
      throw error;
    }
  };

  const recordResult = (input: {
    eventId: string;
    message: Extract<AgentMessage, { role: "toolResult" }>;
    replayIncomplete?: boolean;
  }) => {
    if (abandonedToolCallIds.has(input.message.toolCallId)) {
      replayInvalid = true;
      providerToolReceipts.get(input.message.toolCallId)?.resolve();
      return;
    }
    if (!claim(input.eventId)) {
      if (firstFailure) {
        providerToolReceipts.get(input.message.toolCallId)?.reject(firstFailure);
      }
      return;
    }
    turnTainted ||= readTurnTaintMetadata(input.message)?.resultContentSource === "network";
    schedule(async () => {
      const group = pendingTools;
      if (!group || !group.order.includes(input.message.toolCallId)) {
        throw new Error(`Copilot emitted an unmatched tool result: ${input.message.toolCallId}`);
      }
      const key = providerToolReceipts.has(input.message.toolCallId)
        ? input.eventId
        : `copilot-sdk:${params.sdkSessionId}:${input.eventId}`;
      group.results.set(input.message.toolCallId, {
        eventId: input.eventId,
        message: { ...input.message, idempotencyKey: key } as TranscriptMessage,
      });
      replayInvalid ||= input.replayIncomplete === true;
      if (group.order.every((toolCallId) => group.results.has(toolCallId))) {
        await finishToolGroup(group);
      }
    });
  };

  return {
    async sendSdkUser(send: () => Promise<string>, recorder?: TranscriptRecorder) {
      providerTerminal.assertAccepting();
      const registration = createDeferred<void>();
      // SDK events can precede the send response. Queue the gate before dispatch,
      // then bind the returned id before releasing it; concurrent sends need no FIFO guessing.
      schedule(() => registration.promise);
      try {
        const messageId = await send();
        providerTerminal.acceptSdkUserEvent(messageId);
        if (recorder) {
          sdkUserRecorders.set(messageId, recorder);
          recorder.markSentToProvider?.();
          recorder.markRuntimePersistencePending(sdkUserPersistenceReceipt(messageId).promise);
        }
        return messageId;
      } finally {
        registration.resolve();
      }
    },
    markReplayIncomplete() {
      replayInvalid = true;
    },
    recordAssistantProjectionGap() {
      replayInvalid = true;
      latestAssistantKey = undefined;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      terminalAnchor = undefined;
    },
    async persistInitialUser() {
      const recorder = params.attempt.userTurnTranscriptRecorder;
      if (!recorder) {
        captureFailure(new Error("Copilot transcript requires a user-turn recorder"));
        return await barrier("user prompt");
      }
      if (recorder.isBlocked()) {
        replayInvalid = true;
        replaceTailUser(recorder.message);
        return;
      }
      const persistence = (async () => {
        const resolved = await recorder.resolveMessage();
        if (!resolved) {
          throw new Error("Copilot transcript user turn resolved without a message");
        }
        const outcome = await append({
          message: {
            ...resolved,
            idempotencyKey: `${params.attempt.runId}:user`,
          } as TranscriptMessage,
        });
        replaceTailUser(currentUser);
        if (!outcome) {
          replayInvalid = true;
          recorder.markBlocked();
          return;
        }
        if (outcome.message.role !== "user") {
          throw new Error("Copilot transcript replayed a non-user initial message");
        }
        const persisted = outcome.message;
        accept(outcome);
        persistedInitialUser = persisted;
        terminalAnchor = outcome.anchor;
        recorder.markRuntimePersisted(persisted, outcome.anchor, { appended: outcome.appended });
        params.attempt.onUserMessagePersisted?.(persisted);
        await publish(outcome.appended);
      })();
      recorder.markRuntimePersistencePending(persistence);
      await persistence.catch(captureFailure);
      await barrier("user prompt");
    },
    recordSdkUser(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "user" }>;
      autopilotContinuation: boolean;
      replayIncomplete?: boolean;
    }) {
      const persistenceReceipt = sdkUserPersistenceReceipt(input.eventId);
      if (!claim(input.eventId)) {
        return;
      }
      if (providerTerminal.phase === "finalized") {
        replayInvalid = true;
        providerTerminal.rejectTerminalSdkUserEvent(input.eventId);
        return;
      }
      replayInvalid ||= input.replayIncomplete === true;
      if (!initialSdkUserObserved && !input.autopilotContinuation) {
        initialSdkUserObserved = true;
        if (
          !persistedInitialUser ||
          userText(persistedInitialUser.content) !== userText(input.message.content)
        ) {
          replayInvalid = true;
        } else {
          initialSdkUserValidated = true;
          params.onInitialSdkUserValidated?.();
        }
        persistenceReceipt.resolve();
        return;
      }
      initialSdkUserObserved = true;
      schedule(async () => {
        try {
          const recorder = sdkUserRecorders.get(input.eventId);
          sdkUserRecorders.delete(input.eventId);
          const preparedMessage = await recorder?.resolveMessage();
          const write: PendingWrite = {
            eventId: input.eventId,
            message: restorePreparedUserTurnOperationalMetaForRuntime({
              runtimeMessage: input.message,
              preparedMessage,
            }),
            recorder,
          };
          if (pendingTools || providerTerminal.phase === "finalizing") {
            providerTerminal.defer(write);
            return;
          }
          if (providerTerminal.phase === "finalized") {
            replayInvalid = true;
            providerTerminal.rejectTerminalSdkUserEvent(input.eventId);
            return;
          }
          const outcome = await append(write);
          if (!outcome) {
            replayInvalid = true;
            persistenceReceipt.reject(new Error("Copilot steering user write was suppressed"));
            return;
          }
          await publish(accept(outcome));
          persistenceReceipt.resolve();
        } catch (error) {
          if (providerTerminal.phase === "active") {
            throw error;
          }
          replayInvalid = true;
          providerTerminal.rejectSdkUserEvent(input.eventId, error);
        }
      });
    },
    recordAssistant(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "assistant" }>;
      replayIncomplete?: boolean;
      toolCallIds: string[];
    }) {
      if (!claim(input.eventId)) {
        return;
      }
      replayInvalid ||= input.replayIncomplete === true;
      const message = withAssistantTurnTaint(input.message, turnTainted);
      const key = `copilot-sdk:${params.sdkSessionId}:${input.eventId}`;
      latestAssistantKey = key;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      terminalAnchor = undefined;
      schedule(async () => {
        if (pendingTools) {
          throw new Error("Copilot emitted an assistant message before tool results settled");
        }
        const write = {
          eventId: input.eventId,
          message: Object.assign({}, message, { idempotencyKey: key }),
        };
        if (input.toolCallIds.length > 0) {
          pendingTools = {
            assistant: write,
            assistantKey: key,
            order: input.toolCallIds,
            results: new Map(),
          };
          return;
        }
        const outcome = await append(write);
        if (!outcome) {
          replayInvalid = true;
        }
        ownAssistant(key, Boolean(outcome), outcome?.anchor);
        await publish(accept(outcome));
      });
    },
    recordToolResult(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "toolResult" }>;
      replayIncomplete?: boolean;
    }) {
      if (providerToolReceipts.has(input.message.toolCallId)) {
        return;
      }
      recordResult(input);
    },
    recordProviderToolResult(
      message: Extract<AgentMessage, { role: "toolResult" }>,
    ): Promise<void> {
      const receipt = createDeferred<void>();
      void receipt.promise.catch(() => undefined);
      providerToolReceipts.set(message.toolCallId, receipt);
      recordResult({
        eventId: `copilot-sdk:${params.sdkSessionId}:tool:${message.toolCallId}`,
        message,
      });
      return receipt.promise;
    },
    finalizeProviderTerminal: providerTerminal.finalize,
    waitForSdkUserPersisted(eventId: string) {
      return sdkUserPersistenceReceipt(eventId).promise;
    },
    barrier,
    hasFailed: () => firstFailure !== undefined,
    snapshot: () => ({
      assistantTranscriptOwned,
      assistantTranscriptIdempotencyKey,
      terminalAnchor,
      initialSdkUserValidated,
      messagesSnapshot: [...messagesSnapshot],
      replayInvalid,
    }),
  };
}

function resolveTranscriptTarget(attempt: AttemptParamsLike): SessionTranscriptTargetParams {
  const sessionId = normalizeOptionalString(attempt.sessionTarget?.sessionId);
  const sessionKey = normalizeOptionalString(attempt.sessionTarget?.sessionKey);
  const storePath = normalizeOptionalString(attempt.sessionTarget?.storePath);
  if (!sessionId || !sessionKey || !storePath) {
    const error = new Error(
      "[copilot-attempt] canonical transcript persistence requires an exact runtime session target",
    ) as Error & { code?: string };
    error.code = "transcript_persistence_failed";
    throw error;
  }
  const agentId = normalizeOptionalString(attempt.sessionTarget?.agentId ?? attempt.agentId);
  return { sessionId, sessionKey, storePath, ...(agentId ? { agentId } : {}) };
}
