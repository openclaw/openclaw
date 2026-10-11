import { setTimeout as delay } from "node:timers/promises";
import { APIUserAbortError } from "openai";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  AgentsApiClient,
  isAgentsApiTerminalTurn,
  type AgentsApiEvent,
  type AgentsApiFunctionCall,
  type AgentsApiItem,
} from "./agentsapi-client.js";
import {
  AgentsApiError,
  isAgentsApiOptionalHistoryReadFailure,
  isAgentsApiTransportDisconnect,
} from "./agentsapi-errors.js";
import {
  createAgentsApiSessionHistory,
  waitForAgentsApiEventOrRecovery,
} from "./agentsapi-session-history.js";
import type { AgentsApiToolExecutionResult } from "./agentsapi-tools.js";

/** Native input receipts and session idle, together, establish Agents API completion. */
export function createAgentsApiSession(options: {
  client: AgentsApiClient;
  cleanupClient: AgentsApiClient;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** A fresh session whose creation request already admitted the sole input. */
  initialInputSubmitted?: true;
  waitForRecovery?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent: (event: AgentsApiEvent) => void | Promise<void>;
  onReconcile?: (turn: Turn, items: AgentsApiItem[]) => Promise<void | boolean>;
  onReconcileHistory?: (entries: Array<{ turn: Turn; items: AgentsApiItem[] }>) => Promise<void>;
  onSettled?: () => void;
  onUsageError?: (error: unknown) => void;
  onTranscriptOrderingGap?: () => void;
  executeFunction?: (call: AgentsApiFunctionCall) => Promise<AgentsApiToolExecutionResult>;
  connectEnvironment?: (environmentId: string) => Promise<void>;
  onSessionFailed?: () => Promise<void>;
  onFunctionResult?: (
    call: AgentsApiFunctionCall,
    result: AgentsApiToolExecutionResult,
  ) => void | Promise<void>;
}) {
  const { client, cleanupClient, sessionId, signal, assertCurrent } = options;
  const waitForRecovery =
    options.waitForRecovery ??
    ((ms: number, recoverySignal: AbortSignal) => delay(ms, undefined, { signal: recoverySignal }));
  let streamController = new AbortController();
  let submitted = options.initialInputSubmitted ?? false;
  let inputAdmissionClosed = false;
  let stopped = false;
  let closed = false;
  let settled = false;
  let rootTurn: Turn | AgentsApiEvent["turn"];
  let turnFailure: AgentsApiError | undefined;
  let cancelled = false;
  let submission: Promise<void> = Promise.resolve();
  let admittedSubmission: Promise<void> = Promise.resolve();
  let cancellation: Promise<void> | undefined;
  let admittedMessageCount = submitted ? 1 : 0;
  let baselineTurnId: string | undefined;
  let baselineCaptured = submitted;
  const priorInputItemIds = new Set<string>();
  let observedInputItems = new Set<string>();
  const coordinatorTurnIds = new Set<string>();
  const excludedTurnIds = new Set<string>();
  const itemTurnIds = new Map<string, string>();
  const excludedItemIds = new Set<string>();
  let latestInputTurnId: string | undefined;
  let usageTurns: Promise<Turn[]> | undefined;
  let terminatedByTool = false;
  // Healthy streams remain event-driven. A terminal notification or transport gap
  // needs saved-state recovery because the live stream cannot replay late records.
  let reconciliationPending = options.initialInputSubmitted ?? false;

  const isAvailable = () =>
    submitted && !inputAdmissionClosed && !stopped && !settled && !rootTurn && !signal.aborted;
  const submit = (text: string, persistInput?: () => Promise<void>) => {
    assertCurrent();
    signal.throwIfAborted();
    if (inputAdmissionClosed || stopped || settled || rootTurn) {
      throw new Error("Agents API turn is stopped");
    }
    submission = submission.then(async () => {
      assertCurrent();
      if (stopped || settled || rootTurn || signal.aborted) {
        throw new Error("Agents API turn settled before input was submitted");
      }
      await persistInput?.();
      assertCurrent();
      signal.throwIfAborted();
      if (stopped || settled || rootTurn) {
        throw new Error("Agents API turn settled before input was submitted");
      }
      admittedMessageCount++;
      submitted = true;
      // An admitted POST must finish before native cancellation; aborting its
      // HTTP request would leave acceptance of hosted work indeterminate.
      admittedSubmission = client.message(sessionId, text, AbortSignal.timeout(60_000));
      return admittedSubmission;
    });
    void submission.catch(() => {});
    return submission;
  };
  const cancel = () => {
    stopped = true;
    streamController.abort();
    if (!submitted || settled) {
      return Promise.resolve();
    }
    cancellation ??= (async () => {
      let submissionError: unknown;
      try {
        await admittedSubmission;
      } catch (error) {
        submissionError = error;
      }
      await cleanupClient.cancel(sessionId, AbortSignal.timeout(30_000));
      settled = true;
      if (submissionError !== undefined) {
        throw submissionError instanceof Error
          ? submissionError
          : new Error(formatErrorMessage(submissionError), { cause: submissionError });
      }
    })();
    void cancellation.catch(() => {});
    return cancellation;
  };
  const onAbort = () => {
    void cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const readAdmittedTurns = async (readClient: AgentsApiClient, readSignal: AbortSignal) => {
    const turns = await readClient.turns(sessionId, readSignal, baselineTurnId);
    readSignal.throwIfAborted();
    for (const turn of turns) {
      coordinatorTurnIds.add(turn.id);
      excludedTurnIds.delete(turn.id);
    }
    const latest = turns.at(-1);
    latestInputTurnId = latest?.id;
    rootTurn = latest && isAgentsApiTerminalTurn(latest.status) ? latest : undefined;
    turnFailure =
      latest?.status === "failed"
        ? new AgentsApiError(latest.error?.message ?? "Agents API turn failed", latest.error ?? {})
        : undefined;
    cancelled = !terminatedByTool && latest?.status === "cancelled";
    return turns;
  };
  const rememberItemTurn = (itemId: string, turnId: string) => {
    const previous = itemTurnIds.get(itemId);
    if (previous && previous !== turnId) {
      throw new Error("Agents API item belongs to different admitted turns");
    }
    itemTurnIds.set(itemId, turnId);
    excludedItemIds.delete(itemId);
  };

  const history = createAgentsApiSessionHistory({
    sessionId,
    cleanupClient,
    getBaselineTurnId: () => baselineTurnId,
    coordinatorTurnIds,
    priorInputItemIds,
    readAdmittedTurns,
    rememberItemTurn,
    observeInputItems: (items) => {
      observedInputItems = items;
    },
    callbacks: options,
  });

  return {
    isAvailable,
    wasSubmitted: () => submitted,
    isSettled: () => settled,
    queueMessage: submit,
    readUsageTurns() {
      if (!submitted || !settled) {
        return Promise.resolve([]);
      }
      return (usageTurns ??= history.readUsageTurns());
    },
    async run(prompt: string, persistInput: () => Promise<void>, onSubmitted: () => void) {
      signal.throwIfAborted();
      if (!options.initialInputSubmitted) {
        const latest = (await client.turns(sessionId, signal, undefined, true))[0];
        assertCurrent();
        baselineTurnId = latest?.id;
        if (latest && !isAgentsApiTerminalTurn(latest.status)) {
          // A recovery input can join the still-active native root. Retain its
          // tools and output, but count only inputs admitted by this attempt.
          const turns = await client.turns(sessionId, signal);
          assertCurrent();
          const latestIndex = turns.findIndex((turn) => turn.id === latest.id);
          if (latestIndex < 0) {
            throw new Error("Agents API continuation lost its active root turn");
          }
          baselineTurnId = turns[latestIndex - 1]?.id;
          const items = await client.items(sessionId, latest.id, signal);
          assertCurrent();
          for (const item of items) {
            if (item.type === "message" && item.role === "user") {
              priorInputItemIds.add(item.id);
            }
          }
        }
        baselineCaptured = true;
        if (baselineTurnId) {
          excludedTurnIds.add(baselineTurnId);
        }
      }
      const callAdmissions = new Map<string, { inputCount: number; relayed: boolean }>();
      const relayFunctions = async (): Promise<void> => {
        assertCurrent();
        signal.throwIfAborted();
        let submissionFence = submission;
        await awaitReceipt(submissionFence);
        assertCurrent();
        const inputCount = admittedMessageCount;
        const calls = await client.pendingFunctionCalls(
          sessionId,
          signal,
          options.connectEnvironment,
        );
        if (!calls.length) {
          return;
        }
        if (!options.executeFunction) {
          throw new Error("Agents API MVP cannot continue: agent.session.requires_action");
        }
        // Retain the input watermark for every sibling, including across re-reads.
        for (const call of calls) {
          const identity = `${sessionId}:${call.turn_id}:${call.call_id}`;
          if (!callAdmissions.has(identity)) {
            callAdmissions.set(identity, { inputCount, relayed: false });
          }
        }
        const turns = await readAdmittedTurns(client, signal);
        assertCurrent();
        if (submissionFence !== submission) {
          return relayFunctions();
        }
        const latestTurn = turns.at(-1);
        if (!latestTurn) {
          throw new Error("Agents API function request has no current attempt root turn");
        }
        latestInputTurnId = latestTurn.id;
        const admittedCount = admittedMessageCount;
        let itemsByTurn: Map<string, AgentsApiItem[]> | undefined;
        // This optional history barrier must not retire valid hosted work for
        // a transient read failure or wait indefinitely before a Gateway action.
        const prefixSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
        try {
          itemsByTurn = await history.readItemsByTurn(client, prefixSignal);
          assertCurrent();
        } catch (error) {
          signal.throwIfAborted();
          assertCurrent();
          const prefixAborted =
            prefixSignal.aborted &&
            (error === prefixSignal.reason || error instanceof APIUserAbortError);
          if (!prefixAborted && !isAgentsApiOptionalHistoryReadFailure(error)) {
            throw error;
          }
          options.onTranscriptOrderingGap?.();
          assertCurrent();
        }
        for (const call of calls) {
          if (
            call.turn_id !== latestTurn.id ||
            !["in_progress", "waiting"].includes(latestTurn.status)
          ) {
            throw new Error(
              "Agents API function request belongs to a different or settled root turn",
            );
          }
          const identity = `${sessionId}:${call.turn_id}:${call.call_id}`;
          const admission = callAdmissions.get(identity)!;
          if (admission.relayed) {
            continue;
          }
          // Retrieved native invocations and completed text precede this host
          // receipt. Later items must not overtake its canonical function slot.
          const items = itemsByTurn?.get(call.turn_id);
          const callIndex =
            items?.findIndex(
              (item) => item.type === "function_call" && item.call_id === call.call_id,
            ) ?? -1;
          if (items) {
            // A pending function can precede its saved item. Preserve the available
            // prefix; its existing readiness barrier still fences unresolved slots.
            const prefix = callIndex >= 0 ? items.slice(0, callIndex) : items;
            const transcriptReady = await history.projectSavedState(
              turns.map((turn) => ({
                turn,
                items: turn.id === call.turn_id ? prefix : (itemsByTurn!.get(turn.id) ?? []),
              })),
              signal,
            );
            assertCurrent();
            if (!transcriptReady || callIndex < 0) {
              options.onTranscriptOrderingGap?.();
              assertCurrent();
            }
          } else {
            options.onTranscriptOrderingGap?.();
            assertCurrent();
          }
          if (submissionFence !== submission || admittedCount !== admittedMessageCount) {
            // A steer admitted during the barrier invalidates this captured
            // function batch. Re-read it without repeating a claimed action.
            return relayFunctions();
          }
          // Claim before execution so duplicate events cannot repeat a Gateway side effect.
          admission.relayed = true;
          const result = await options.executeFunction(call);
          assertCurrent();
          signal.throwIfAborted();
          const terminate = result.terminate || result.sourceReplyDelivered;
          if (terminate) {
            // Fence new input before the acknowledgement can resume native work.
            // Already reserved input remains ahead of that acknowledgement.
            inputAdmissionClosed = true;
          }
          submission = submission.then(() => {
            assertCurrent();
            signal.throwIfAborted();
            admittedSubmission = client.toolResult(
              sessionId,
              call,
              result,
              AbortSignal.timeout(60_000),
            );
            return admittedSubmission;
          });
          void submission.catch(() => {});
          const acknowledgementFence = submission;
          await awaitReceipt(acknowledgementFence);
          submissionFence = acknowledgementFence;
          await options.onFunctionResult?.(call, result);
          assertCurrent();
          if (terminate) {
            if (admittedMessageCount !== admission.inputCount) {
              // A terminal reply cannot cancel a newer accepted follow-up.
              inputAdmissionClosed = false;
              return relayFunctions();
            }
            // Acknowledge the host's delivered reply before retiring native work.
            await cleanupClient.cancel(sessionId, AbortSignal.timeout(30_000));
            terminatedByTool = true;
            await settleFromSavedState();
            if (
              !settled ||
              !rootTurn ||
              !["completed", "cancelled"].includes(rootTurn.status ?? "")
            ) {
              throw new Error(
                "Agents API tool termination did not settle its native root turn and inputs",
              );
            }
            streamController.abort();
            return;
          }
        }
      };
      let events = await client.subscribe(
        sessionId,
        AbortSignal.any([signal, streamController.signal]),
      );
      let nextEvent = events.next();
      void nextEvent.catch(() => {});
      const bufferedEvents: AgentsApiEvent[] = [];
      const reconnectEvents = async () => {
        reconciliationPending = true;
        streamController.abort();
        // A broken reader can reject return() as well as next(). Retire only
        // this transport; the admitted native work remains in the session.
        await events.return(undefined).catch((error: unknown) => {
          if (!isAgentsApiTransportDisconnect(error)) {
            throw error;
          }
        });
        while (true) {
          await waitForRecovery(500, signal);
          assertCurrent();
          streamController = new AbortController();
          try {
            // Subscribe before reconciliation: Agents API streams do not replay.
            events = await client.subscribe(
              sessionId,
              AbortSignal.any([signal, streamController.signal]),
            );
            break;
          } catch (error) {
            streamController.abort();
            signal.throwIfAborted();
            assertCurrent();
            if (!isAgentsApiTransportDisconnect(error)) {
              throw error;
            }
          }
        }
        nextEvent = events.next();
        void nextEvent.catch(() => {});
        if (options.connectEnvironment) {
          // Streams do not replay. Recover a connection request emitted while
          // detached even when the input response has not arrived yet.
          await client.pendingFunctionCalls(sessionId, signal, options.connectEnvironment);
          assertCurrent();
        }
      };
      let initialConnectionReconciled = false;
      const awaitReceipt = async (receipt: Promise<void>) => {
        if (!initialConnectionReconciled && options.connectEnvironment) {
          initialConnectionReconciled = true;
          // The subscription cannot replay an action emitted before it opened.
          // Resolve that action while the admitted input receipt is still pending.
          await client.pendingFunctionCalls(sessionId, signal, options.connectEnvironment);
          assertCurrent();
        }
        const acknowledged = receipt.then(
          () => ({ kind: "acknowledged" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        while (true) {
          signal.throwIfAborted();
          let chunk: IteratorResult<AgentsApiEvent> | Awaited<typeof acknowledged>;
          try {
            chunk = await Promise.race([acknowledged, nextEvent]);
          } catch (error) {
            signal.throwIfAborted();
            assertCurrent();
            if (!isAgentsApiTransportDisconnect(error)) {
              throw error;
            }
            chunk = { done: true, value: undefined };
          }
          if ("kind" in chunk) {
            if (chunk.kind === "failed") {
              throw chunk.error;
            }
            return;
          }
          if (chunk.done) {
            await reconnectEvents();
            continue;
          }
          bufferedEvents.push(chunk.value);
          nextEvent = events.next();
          void nextEvent.catch(() => {});
          if (chunk.value.type === "agent.session.requires_action" && options.connectEnvironment) {
            // Only connection startup may cross an input receipt fence. Keep
            // presentation and Gateway functions ordered in the main consumer.
            await client.pendingFunctionCalls(sessionId, signal, options.connectEnvironment);
            assertCurrent();
          }
        }
      };
      const settleFromSavedState = async (recover = false): Promise<void> => {
        const submissionFence = submission;
        await awaitReceipt(submissionFence);
        assertCurrent();
        const admittedCount = admittedMessageCount;
        const snapshot = await history.readSavedState(client, signal);
        assertCurrent();
        const session = await client.session(sessionId, signal);
        assertCurrent();
        if (session.status === "failed") {
          await options.onSessionFailed?.();
          throw new Error(session.error ?? "Agents API session failed");
        }
        if (session.status === "requires_action") {
          await relayFunctions();
          if (settled) {
            return;
          }
        }
        settled = Boolean(
          rootTurn &&
          rootTurn.id === snapshot.turns.at(-1)?.id &&
          session.status === "idle" &&
          submissionFence === submission &&
          admittedCount === admittedMessageCount &&
          observedInputItems.size === admittedCount,
        );
        if (settled) {
          options.onSettled?.();
        }
        if (settled || recover) {
          if (settled) {
            await history.reconcilePriorHistory(client, signal, snapshot.itemsByTurn);
            assertCurrent();
          }
          await history.projectSavedState(snapshot.entries, signal);
          assertCurrent();
        }
      };
      const belongsToAttempt = async (event: AgentsApiEvent) => {
        if (event.item && event.item_id && event.item.id !== event.item_id) {
          throw new Error("Agents API event contains different item identities");
        }
        const itemId = event.item?.id ?? event.item_id;
        const turnIds = new Set(
          [
            event.turn?.id,
            event.turn_id,
            event.item?.turn_id,
            itemId ? itemTurnIds.get(itemId) : undefined,
          ].filter((id): id is string => typeof id === "string" && id.length > 0),
        );
        if (turnIds.size > 1) {
          throw new Error("Agents API event contains different turn identities");
        }
        const turnId = turnIds.values().next().value;
        if (!turnId) {
          if (itemId) {
            if (excludedItemIds.has(itemId)) {
              return false;
            }
            // Command deltas can omit their turn; saved admitted items retain that correlation.
            const snapshot = await history.readSavedState(client, signal);
            assertCurrent();
            if (!itemTurnIds.has(itemId)) {
              excludedItemIds.add(itemId);
              return false;
            }
            await history.projectSavedState(snapshot.entries, signal);
            assertCurrent();
            return true;
          }
          if (event.item || event.type === "agent.output.command_execution_output.delta") {
            throw new Error("Agents API output event is missing its turn ID");
          }
          return true;
        }
        if (excludedTurnIds.has(turnId)) {
          if (itemId) {
            excludedItemIds.add(itemId);
          }
          return false;
        }
        if (!coordinatorTurnIds.has(turnId)) {
          // A delayed same-session event is not proof that this attempt admitted its turn.
          await readAdmittedTurns(client, signal);
          assertCurrent();
          if (!coordinatorTurnIds.has(turnId)) {
            excludedTurnIds.add(turnId);
            if (itemId) {
              excludedItemIds.add(itemId);
            }
            return false;
          }
        }
        if (event.item) {
          rememberItemTurn(event.item.id, turnId);
        }
        return true;
      };
      try {
        await persistInput();
        assertCurrent();
        signal.throwIfAborted();
        if (!options.initialInputSubmitted) {
          await awaitReceipt(submit(prompt));
        }
        onSubmitted();
        if (options.initialInputSubmitted) {
          // Creation can finish inference before this non-replaying stream opens.
          await settleFromSavedState(true);
        }
        while (true) {
          if (settled) {
            break;
          }
          let chunk: IteratorResult<AgentsApiEvent> | undefined;
          let consumedBufferedEvent = false;
          try {
            const buffered = bufferedEvents.shift();
            if (buffered) {
              consumedBufferedEvent = true;
              chunk = { done: false, value: buffered };
            } else if (reconciliationPending) {
              // Terminal and disconnected-stream records may lag their last live event.
              // Keep the next event in flight while reconciling within the attempt deadline.
              chunk = await waitForAgentsApiEventOrRecovery(nextEvent, signal, waitForRecovery);
            } else {
              chunk = await nextEvent;
            }
          } catch (error) {
            signal.throwIfAborted();
            assertCurrent();
            if (!isAgentsApiTransportDisconnect(error)) {
              throw error;
            }
            chunk = { done: true, value: undefined };
          }
          if (!chunk) {
            await settleFromSavedState(true);
            continue;
          }
          if (chunk.done) {
            await reconnectEvents();
            await settleFromSavedState(true);
            continue;
          }
          const event = chunk.value;
          if (!consumedBufferedEvent) {
            nextEvent = events.next();
            void nextEvent.catch(() => {});
          }
          assertCurrent();
          if (!(await belongsToAttempt(event))) {
            continue;
          }
          assertCurrent();
          await options.onEvent(event);
          assertCurrent();
          if (event.type === "agent.session.idle") {
            reconciliationPending = true;
            await settleFromSavedState();
            continue;
          }
          if (
            (event.type === "agent.session.turn.item.added" ||
              event.type === "agent.session.turn.item.done") &&
            event.item?.type === "message" &&
            event.item.role === "user" &&
            event.item.id &&
            !priorInputItemIds.has(event.item.id) &&
            !observedInputItems.has(event.item.id)
          ) {
            observedInputItems.add(event.item.id);
            const inputTurnId =
              event.item.turn_id ?? event.turn_id ?? itemTurnIds.get(event.item.id);
            if (!inputTurnId) {
              throw new Error("Agents API input item is missing its turn ID");
            }
            // The input receipt can arrive after the final idle notification.
            await settleFromSavedState();
          }
          if (event.type === "error") {
            throw new AgentsApiError(
              event.error?.message ?? "Agents API stream error",
              event.error,
            );
          }
          if (event.type === "agent.session.requires_action") {
            await relayFunctions();
            continue;
          }
          if (event.type === "agent.session.failed") {
            const session = await client.session(sessionId, signal);
            assertCurrent();
            if (session.status !== "failed") {
              continue;
            }
            await options.onSessionFailed?.();
            throw new AgentsApiError(session.error ?? "Agents API session failed", event.error);
          }
          if (event.type === "agent.session.environment.failed") {
            const nativeError = event.environment?.error ?? event.error;
            throw new AgentsApiError(
              nativeError?.message ??
                event.session?.error ??
                `Agents API cannot continue: ${event.type}`,
              nativeError ?? {},
            );
          }
          if (
            (event.type === "agent.session.turn.completed" ||
              event.type === "agent.session.turn.failed" ||
              event.type === "agent.session.turn.cancelled") &&
            event.turn?.subagent_id === null &&
            event.turn.id === latestInputTurnId
          ) {
            reconciliationPending = true;
            rootTurn = event.turn;
            turnFailure = event.type.endsWith(".failed")
              ? new AgentsApiError(
                  event.turn.error?.message ?? "Agents API turn failed",
                  event.turn.error ?? {},
                )
              : undefined;
            cancelled = event.type.endsWith(".cancelled");
            await settleFromSavedState();
          }
        }
      } finally {
        streamController.abort();
        await events.return(undefined);
      }
      if (!rootTurn || !settled) {
        throw new Error(
          "Agents API stream closed before the root turn settled; reset or inspect the session before retrying",
        );
      }
      if (turnFailure) {
        throw turnFailure;
      }
      return { turn: rootTurn, cancelled, terminatedByTool };
    },
    async reconcileAfterClose(cleanupSignal: AbortSignal): Promise<Turn | undefined> {
      if (!closed) {
        throw new Error("Agents API session cleanup requires a closed session attempt");
      }
      if (!submitted || !baselineCaptured) {
        return undefined;
      }
      cleanupSignal.throwIfAborted();
      const session = await cleanupClient.session(sessionId, cleanupSignal);
      cleanupSignal.throwIfAborted();
      if (session.status === "failed") {
        await options.onSessionFailed?.();
      }
      if (session.status !== "idle" && session.status !== "failed") {
        throw new Error("Agents API session cleanup requires native work to be retired");
      }
      const snapshot = await history.readSavedState(cleanupClient, cleanupSignal);
      await history.reconcilePriorHistory(cleanupClient, cleanupSignal, snapshot.itemsByTurn);
      await history.projectSavedState(snapshot.entries, cleanupSignal);
      return snapshot.turns.at(-1);
    },
    async close() {
      signal.removeEventListener("abort", onAbort);
      streamController.abort();
      if (submitted && !settled) {
        await cancel();
      }
      await cancellation;
      stopped = true;
      closed = true;
    },
  };
}
