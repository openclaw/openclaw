import { setTimeout as delay } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { AgentsApiClient, type AgentsApiEvent, type AgentsApiTurn } from "./agentsapi-client.js";

/** Native input receipts and session idle, together, establish Agents API completion. */
export function createAgentsApiSession(options: {
  client: AgentsApiClient;
  cleanupClient: AgentsApiClient;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  onEvent: (event: AgentsApiEvent) => void;
  onSettled?: () => void;
  onUsageError?: (error: unknown) => void;
}) {
  const { client, cleanupClient, sessionId, signal, assertCurrent } = options;
  let streamController = new AbortController();
  let submitted = false;
  let stopped = false;
  let settled = false;
  let rootTurn: AgentsApiTurn | undefined;
  let turnFailure: string | undefined;
  let cancelled = false;
  let submission: Promise<void> = Promise.resolve();
  let admittedSubmission: Promise<void> = Promise.resolve();
  let cancellation: Promise<void> | undefined;
  let admittedMessageCount = 0;
  const observedInputItems = new Set<string>();
  const coordinatorTurnIds = new Set<string>();
  let latestInputTurnId: string | undefined;
  let baselineTurnId: string | undefined;
  let usageTurns: Promise<AgentsApiTurn[]> | undefined;

  const isAvailable = () => submitted && !stopped && !settled && !rootTurn && !signal.aborted;
  const submit = (text: string) => {
    assertCurrent();
    signal.throwIfAborted();
    if (stopped || settled || rootTurn) {
      throw new Error("Agents API turn is stopped");
    }
    submission = submission.then(() => {
      assertCurrent();
      if (stopped || settled || rootTurn || signal.aborted) {
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

  const collectInputs = async (turnId: string) => {
    for (const item of await client.items(sessionId, turnId, signal)) {
      if (item.type === "message" && item.role === "user" && item.id) {
        observedInputItems.add(item.id);
      }
    }
  };
  const assertSessionUsable = (session: { status: string; error: string | null }) => {
    if (session.status === "failed") {
      throw new Error(session.error ?? "Agents API session failed");
    }
    if (session.status === "requires_action") {
      throw new Error("Agents API MVP cannot continue: agent.session.requires_action");
    }
  };

  return {
    isAvailable,
    wasSubmitted: () => submitted,
    isSettled: () => settled,
    queueMessage: submit,
    cancel,
    readUsageTurns() {
      if (!submitted || !settled) {
        return Promise.resolve([]);
      }
      return (usageTurns ??= (async () => {
        const usageSignal = AbortSignal.timeout(5_000);
        let turns: AgentsApiTurn[] = [];
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
      let events = await client.subscribe(
        sessionId,
        AbortSignal.any([signal, streamController.signal]),
      );
      let nextEvent = events.next();
      void nextEvent.catch(() => {});
      let reconciledStream = false;
      try {
        await persistInput();
        assertCurrent();
        signal.throwIfAborted();
        await submit(prompt);
        onSubmitted();
        while (!settled) {
          const chunk = await nextEvent;
          if (chunk.done) {
            reconciledStream = true;
            streamController.abort();
            await events.return(undefined);
            await delay(500, undefined, { signal });
            streamController = new AbortController();
            // Subscribe before reconciliation: Agents API streams do not replay.
            events = await client.subscribe(
              sessionId,
              AbortSignal.any([signal, streamController.signal]),
            );
            nextEvent = events.next();
            void nextEvent.catch(() => {});
            await submission;
            const admittedCount = admittedMessageCount;
            const turns = await client.turns(sessionId, signal, baselineTurnId);
            for (const turn of turns) {
              coordinatorTurnIds.add(turn.id);
              await collectInputs(turn.id);
            }
            const latestTurn = turns.at(-1);
            if (latestTurn) {
              latestInputTurnId = latestTurn.id;
              rootTurn = ["completed", "failed", "cancelled"].includes(latestTurn.status)
                ? latestTurn
                : undefined;
              turnFailure =
                latestTurn.status === "failed"
                  ? (latestTurn.error?.message ?? "Agents API turn failed")
                  : undefined;
              cancelled = latestTurn.status === "cancelled";
            }
            const session = await client.session(sessionId, signal);
            assertCurrent();
            assertSessionUsable(session);
            settled = Boolean(
              rootTurn &&
              session.status === "idle" &&
              admittedCount === admittedMessageCount &&
              observedInputItems.size >= admittedMessageCount,
            );
            continue;
          }
          const event = chunk.value;
          nextEvent = events.next();
          void nextEvent.catch(() => {});
          assertCurrent();
          options.onEvent(event);
          if (rootTurn && event.type === "agent.session.idle") {
            await submission;
            assertCurrent();
            if (observedInputItems.size < admittedMessageCount) {
              for (const turnId of coordinatorTurnIds) {
                await collectInputs(turnId);
              }
            }
            if (
              observedInputItems.size < admittedMessageCount ||
              rootTurn.id !== latestInputTurnId
            ) {
              continue;
            }
            if (reconciledStream) {
              const session = await client.session(sessionId, signal);
              assertSessionUsable(session);
              if (session.status !== "idle") {
                continue;
              }
            }
            settled = true;
            break;
          }
          if (event.type === "agent.session.turn.created" && event.turn?.subagent_id === null) {
            if (!coordinatorTurnIds.has(event.turn.id)) {
              coordinatorTurnIds.add(event.turn.id);
              latestInputTurnId = event.turn.id;
              rootTurn = undefined;
              turnFailure = undefined;
              cancelled = false;
            }
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
            const inputTurnId = event.item.turn_id ?? event.turn_id;
            if (!inputTurnId) {
              throw new Error("Agents API input item is missing its turn ID");
            }
            if (!latestInputTurnId) {
              coordinatorTurnIds.add(inputTurnId);
              latestInputTurnId = inputTurnId;
            }
          }
          if (event.type === "error") {
            throw new Error(event.error?.message ?? "Agents API stream error");
          }
          if (
            [
              "agent.session.failed",
              "agent.session.environment.failed",
              "agent.session.requires_action",
            ].includes(event.type)
          ) {
            throw new Error(`Agents API MVP cannot continue: ${event.type}`);
          }
          if (
            (event.type === "agent.session.turn.completed" ||
              event.type === "agent.session.turn.failed" ||
              event.type === "agent.session.turn.cancelled") &&
            event.turn.subagent_id === null &&
            event.turn.id === latestInputTurnId
          ) {
            rootTurn = event.turn;
            turnFailure = event.type.endsWith(".failed")
              ? (event.turn.error?.message ?? "Agents API turn failed")
              : undefined;
            cancelled = event.type.endsWith(".cancelled");
          }
        }
        options.onSettled?.();
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
        throw new Error(turnFailure);
      }
      return { turn: rootTurn, cancelled };
    },
    async close() {
      signal.removeEventListener("abort", onAbort);
      streamController.abort();
      if (submitted && !settled) {
        await cancel();
      }
      await cancellation;
      stopped = true;
    },
  };
}
