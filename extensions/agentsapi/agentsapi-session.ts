import { setTimeout as delay } from "node:timers/promises";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  AgentsApiClient,
  AgentsApiError,
  isAgentsApiTerminalTurn,
  type AgentsApiEvent,
  type AgentsApiFunctionCall,
  type AgentsApiItem,
} from "./agentsapi-client.js";
import type { AgentsApiToolExecutionResult } from "./agentsapi-tools.js";

/** Native input receipts and session idle, together, establish Agents API completion. */
export function createAgentsApiSession(options: {
  client: AgentsApiClient;
  cleanupClient: AgentsApiClient;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  onEvent: (event: AgentsApiEvent) => void | Promise<void>;
  onReconcile?: (turn: Turn, items: AgentsApiItem[]) => Promise<void | boolean>;
  onReconcileHistory?: (entries: Array<{ turn: Turn; items: AgentsApiItem[] }>) => Promise<void>;
  onSettled?: () => void;
  onUsageError?: (error: unknown) => void;
  onTranscriptOrderingGap?: () => void;
  executeFunction?: (call: AgentsApiFunctionCall) => Promise<AgentsApiToolExecutionResult>;
  onFunctionResult?: (
    call: AgentsApiFunctionCall,
    result: AgentsApiToolExecutionResult,
  ) => void | Promise<void>;
}) {
  const { client, cleanupClient, sessionId, signal, assertCurrent } = options;
  let streamController = new AbortController();
  let submitted = false;
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
  let admittedMessageCount = 0;
  let baselineTurnId: string | undefined;
  let baselineCaptured = false;
  const observedInputItems = new Set<string>();
  const coordinatorTurnIds = new Set<string>();
  const excludedTurnIds = new Set<string>();
  const itemTurnIds = new Map<string, string>();
  const excludedItemIds = new Set<string>();
  let latestInputTurnId: string | undefined;
  let usageTurns: Promise<Turn[]> | undefined;
  let terminatedByTool = false;

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

  const assertSessionUsable = (session: { status: string; error: string | null }) => {
    if (session.status === "failed") {
      throw new Error(session.error ?? "Agents API session failed");
    }
  };
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
  const readItemsByTurn = async (readClient: AgentsApiClient, readSignal: AbortSignal) => {
    const savedItems = await readClient.items(sessionId, undefined, readSignal);
    readSignal.throwIfAborted();
    const itemsByTurn = new Map<string, AgentsApiItem[]>();
    for (const item of savedItems) {
      if (!item.turn_id) {
        continue;
      }
      const items = itemsByTurn.get(item.turn_id) ?? [];
      items.push(item);
      itemsByTurn.set(item.turn_id, items);
    }
    return itemsByTurn;
  };
  const readSavedState = async (readClient: AgentsApiClient, readSignal: AbortSignal) => {
    const turns = await readAdmittedTurns(readClient, readSignal);
    const entries: Array<{ turn: Turn; items: AgentsApiItem[] }> = [];
    const inputItems = new Set<string>();
    const itemsByTurn =
      turns.length || baselineTurnId
        ? await readItemsByTurn(readClient, readSignal)
        : new Map<string, AgentsApiItem[]>();
    for (const turn of turns) {
      const items = itemsByTurn.get(turn.id) ?? [];
      for (const item of items) {
        if (item.turn_id && item.turn_id !== turn.id) {
          throw new Error("Agents API saved item belongs to a different turn");
        }
        rememberItemTurn(item.id, turn.id);
        if (item.type === "message" && item.role === "user") {
          inputItems.add(item.id);
        }
      }
      entries.push({ turn, items });
    }
    observedInputItems.clear();
    for (const id of inputItems) {
      observedInputItems.add(id);
    }
    return { turns, entries, itemsByTurn };
  };
  const projectSavedState = async (
    entries: Array<{ turn: Turn; items: AgentsApiItem[] }>,
    readSignal: AbortSignal,
  ) => {
    let transcriptReady = true;
    for (const { turn, items } of entries) {
      readSignal.throwIfAborted();
      const ready = await options.onReconcile?.(turn, items);
      transcriptReady = ready !== false && transcriptReady;
      readSignal.throwIfAborted();
    }
    return transcriptReady;
  };
  const reconcilePriorHistory = async (
    readClient: AgentsApiClient,
    readSignal: AbortSignal,
    itemsByTurn: Map<string, AgentsApiItem[]>,
  ) => {
    if (!baselineTurnId || !options.onReconcileHistory) {
      return;
    }
    const turns = await readClient.turns(sessionId, readSignal);
    readSignal.throwIfAborted();
    const baselineIndex = turns.findIndex((turn) => turn.id === baselineTurnId);
    if (baselineIndex < 0) {
      throw new Error("Agents API historical reconciliation lost its baseline turn");
    }
    const priorTurns = turns
      .slice(0, baselineIndex + 1)
      .filter((turn) => isAgentsApiTerminalTurn(turn.status));
    if (!priorTurns.length) {
      return;
    }
    // Historical facts repair the retained conversation without entering this
    // attempt's admission, live presentation, tool lifecycle, or token accounting.
    await options.onReconcileHistory(
      priorTurns.map((turn) => ({
        turn,
        items: itemsByTurn.get(turn.id) ?? [],
      })),
    );
    readSignal.throwIfAborted();
  };
  const rememberItemTurn = (itemId: string, turnId: string) => {
    const previous = itemTurnIds.get(itemId);
    if (previous && previous !== turnId) {
      throw new Error("Agents API item belongs to different admitted turns");
    }
    itemTurnIds.set(itemId, turnId);
    excludedItemIds.delete(itemId);
  };

  return {
    isAvailable,
    wasSubmitted: () => submitted,
    isSettled: () => settled,
    queueMessage: submit,
    readUsageTurns() {
      if (!submitted || !settled) {
        return Promise.resolve([]);
      }
      return (usageTurns ??= (async () => {
        const usageSignal = AbortSignal.timeout(5_000);
        let turns: Turn[] = [];
        // Idle can precede the REST records and their usage. Give accounting
        // a bounded settlement window, without treating unknown usage as zero.
        try {
          while (true) {
            turns = await cleanupClient.turns(sessionId, usageSignal, baselineTurnId);
            const recordedIds = new Set(turns.map((turn) => turn.id));
            if (
              turns.length > 0 &&
              [...coordinatorTurnIds].every((id) => recordedIds.has(id)) &&
              turns.every((turn) => turn.usage !== null)
            ) {
              return turns;
            }
            await delay(500, undefined, { signal: usageSignal });
          }
        } catch (error) {
          if (!usageSignal.aborted) {
            options.onUsageError?.(error);
          }
          return turns;
        }
      })());
    },
    async run(prompt: string, persistInput: () => Promise<void>, onSubmitted: () => void) {
      signal.throwIfAborted();
      baselineTurnId = (await client.turns(sessionId, signal, undefined, true))[0]?.id;
      baselineCaptured = true;
      if (baselineTurnId) {
        excludedTurnIds.add(baselineTurnId);
      }
      const callAdmissions = new Map<string, { inputCount: number; relayed: boolean }>();
      const relayFunctions = async (): Promise<void> => {
        assertCurrent();
        signal.throwIfAborted();
        if (!options.executeFunction) {
          throw new Error("Agents API MVP cannot continue: agent.session.requires_action");
        }
        let submissionFence = submission;
        await submissionFence;
        assertCurrent();
        const inputCount = admittedMessageCount;
        const calls = await client.pendingFunctionCalls(sessionId, signal);
        if (!calls.length) {
          return;
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
          itemsByTurn = await readItemsByTurn(client, prefixSignal);
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
            const transcriptReady = await projectSavedState(
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
          await acknowledgementFence;
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
      const settleFromSavedState = async (recover = false): Promise<void> => {
        const submissionFence = submission;
        await submissionFence;
        assertCurrent();
        const admittedCount = admittedMessageCount;
        const snapshot = await readSavedState(client, signal);
        assertCurrent();
        const session = await client.session(sessionId, signal);
        assertCurrent();
        assertSessionUsable(session);
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
            await reconcilePriorHistory(client, signal, snapshot.itemsByTurn);
            assertCurrent();
          }
          await projectSavedState(snapshot.entries, signal);
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
            const snapshot = await readSavedState(client, signal);
            assertCurrent();
            if (!itemTurnIds.has(itemId)) {
              excludedItemIds.add(itemId);
              return false;
            }
            await projectSavedState(snapshot.entries, signal);
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
        await submit(prompt);
        onSubmitted();
        while (true) {
          if (settled) {
            break;
          }
          let chunk: IteratorResult<AgentsApiEvent>;
          try {
            chunk = await nextEvent;
          } catch (error) {
            signal.throwIfAborted();
            assertCurrent();
            if (!isAgentsApiTransportDisconnect(error)) {
              throw error;
            }
            chunk = { done: true, value: undefined };
          }
          if (chunk.done) {
            streamController.abort();
            // A broken reader can reject return() as well as next(). Retire only
            // this transport; the admitted native work remains in the session.
            await events.return(undefined).catch((error: unknown) => {
              if (!isAgentsApiTransportDisconnect(error)) {
                throw error;
              }
            });
            while (true) {
              await delay(500, undefined, { signal });
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
            await settleFromSavedState(true);
            continue;
          }
          const event = chunk.value;
          nextEvent = events.next();
          void nextEvent.catch(() => {});
          assertCurrent();
          if (!(await belongsToAttempt(event))) {
            continue;
          }
          assertCurrent();
          await options.onEvent(event);
          assertCurrent();
          if (event.type === "agent.session.idle") {
            await settleFromSavedState();
            continue;
          }
          if (
            (event.type === "agent.session.turn.item.added" ||
              event.type === "agent.session.turn.item.done") &&
            event.item?.type === "message" &&
            event.item.role === "user" &&
            event.item.id &&
            !observedInputItems.has(event.item.id)
          ) {
            observedInputItems.add(event.item.id);
            const inputTurnId =
              event.item.turn_id ?? event.turn_id ?? itemTurnIds.get(event.item.id);
            if (!inputTurnId) {
              throw new Error("Agents API input item is missing its turn ID");
            }
          }
          if (event.type === "error") {
            throw new AgentsApiError(
              event.error?.message ?? "Agents API stream error",
              event.error,
            );
          }
          if (event.type === "agent.session.requires_action") {
            await relayFunctions();
            if (settled) {
              break;
            }
            continue;
          }
          if (["agent.session.failed", "agent.session.environment.failed"].includes(event.type)) {
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
        throw new Error("Agents API canonical cleanup requires a closed session attempt");
      }
      if (!submitted || !baselineCaptured) {
        return undefined;
      }
      cleanupSignal.throwIfAborted();
      const session = await cleanupClient.session(sessionId, cleanupSignal);
      cleanupSignal.throwIfAborted();
      if (session.status !== "idle" && session.status !== "failed") {
        throw new Error("Agents API canonical cleanup requires native work to be retired");
      }
      const snapshot = await readSavedState(cleanupClient, cleanupSignal);
      await reconcilePriorHistory(cleanupClient, cleanupSignal, snapshot.itemsByTurn);
      await projectSavedState(snapshot.entries, cleanupSignal);
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

function isAgentsApiTransportDisconnect(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AgentsApiError) {
    return false;
  }
  const code = asOptionalRecord(error)?.code;
  if (
    (typeof code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code)) ||
    (error instanceof TypeError && ["terminated", "fetch failed"].includes(error.message))
  ) {
    return true;
  }
  return error.cause instanceof Error && isAgentsApiTransportDisconnect(error.cause);
}

function isAgentsApiOptionalHistoryReadFailure(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    (error instanceof APIError && (error.status === 429 || (error.status ?? 0) >= 500))
  );
}
