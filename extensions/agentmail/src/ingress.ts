import { isDurableInboundReceiveCapacityError } from "openclaw/plugin-sdk/channel-outbound";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { createAgentMailDurableInboundReceiveJournal } from "./durable-receive.js";
import { createAgentMailDurableInboundId } from "./durable-receive.js";
import type { AgentMailIngressRecord } from "./types.js";

type AgentMailJournal = ReturnType<typeof createAgentMailDurableInboundReceiveJournal>;

type DispatchParams = {
  journal: AgentMailJournal;
  id: string;
  record: AgentMailIngressRecord;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelay?: (attempt: number) => number;
  initialAttempts: number;
  dispatchCompleted?: boolean;
};

export type AgentMailIngressDispatch = (
  record: AgentMailIngressRecord,
  lifecycle: { onTurnAdopted: () => Promise<void> },
) => Promise<void>;

type ActiveDispatch = {
  task: Promise<boolean>;
  successor?: DispatchParams;
};

// Durable ids include account + inbox + message, so this also coordinates overlapping account
// restarts that open separate journal facades over the same shared queue.
const activeDispatches = new Map<string, ActiveDispatch>();

export class AgentMailIngressCapacityError extends Error {
  constructor() {
    super("AgentMail durable ingress capacity is full");
    this.name = "AgentMailIngressCapacityError";
  }
}

function retryDelayMs(attempt: number): number {
  return computeBackoff({ initialMs: 1_000, maxMs: 30 * 60_000, factor: 2, jitter: 0.2 }, attempt);
}

async function waitForRetry(signal: AbortSignal | undefined, delayMs: number): Promise<boolean> {
  try {
    await sleepWithAbort(delayMs, signal);
    return !signal?.aborted;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function processAgentMailIngress(params: {
  journal: AgentMailJournal;
  record: AgentMailIngressRecord;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
}): Promise<"accepted" | "duplicate"> {
  const id = createAgentMailDurableInboundId(params.record);
  let accepted: Awaited<ReturnType<AgentMailJournal["accept"]>>;
  try {
    accepted = await params.journal.accept(id, params.record, {
      receivedAt: params.record.receivedAt,
    });
  } catch (error) {
    // Normalize the generic admission result so transports can apply plugin-owned backpressure.
    if (isDurableInboundReceiveCapacityError(error)) {
      throw new AgentMailIngressCapacityError();
    }
    throw error;
  }
  if (accepted.kind === "completed" || accepted.kind === "failed") {
    return "duplicate";
  }
  const record = accepted.kind === "pending" ? accepted.record.payload : params.record;
  // Pending duplicates also register as successors. This closes the account-reload race where a
  // replacement replay ran just before the old account admitted its final live event.
  scheduleAgentMailIngressDispatch({
    journal: params.journal,
    id,
    record,
    dispatch: params.dispatch,
    abortSignal: params.abortSignal,
    retryDelay: params.retryDelayMs,
    initialAttempts: accepted.kind === "pending" ? accepted.record.attempts : 0,
  });
  return "accepted";
}

function scheduleAgentMailIngressDispatch(params: DispatchParams): void {
  const existing = activeDispatches.get(params.id);
  if (existing) {
    // If the current owner shuts down before settling the row, its replacement resumes it.
    existing.successor = params;
    return;
  }
  const active: ActiveDispatch = {
    task: dispatchAgentMailIngressUntilSettled(params),
  };
  activeDispatches.set(params.id, active);
  const finish = (completed: boolean) => {
    if (activeDispatches.get(params.id) !== active) {
      return;
    }
    activeDispatches.delete(params.id);
    if (!completed && active.successor && !active.successor.abortSignal?.aborted) {
      // Completion-marker retries must never repeat an agent turn that already finished.
      active.successor.dispatchCompleted ||= params.dispatchCompleted;
      scheduleAgentMailIngressDispatch(active.successor);
    }
  };
  void active.task.then(finish, () => finish(false));
}

async function dispatchAgentMailIngressUntilSettled(params: DispatchParams): Promise<boolean> {
  let attempts = params.initialAttempts;
  while (!params.abortSignal?.aborted) {
    if (!params.dispatchCompleted) {
      let turnAdopted = false;
      const onTurnAdopted = async () => {
        if (turnAdopted) {
          return;
        }
        // Core persists restart-recovery delivery state before this callback. A fresh turn does
        // not begin if it rejects; an already-committed active steer falls through to the
        // marker-only retry below. Completing here closes the normal crash window before tools.
        await params.journal.complete(params.id);
        turnAdopted = true;
        params.dispatchCompleted = true;
      };
      try {
        await params.dispatch(params.record, { onTurnAdopted });
        if (turnAdopted) {
          return true;
        }
        params.dispatchCompleted = true;
      } catch (error) {
        if (turnAdopted) {
          // The adopted turn is now owned by core's restart-recovery machinery. Releasing the
          // ingress row would replay agent tools even if the later turn failed.
          return true;
        }
        attempts += 1;
        const lastError = errorText(error);
        while (!params.abortSignal?.aborted) {
          try {
            const released = await params.journal.release(params.id, { lastError });
            if (!released) {
              // A concurrent completion or retention prune means this worker no longer owns a
              // pending row. Redispatching without ownership could duplicate an adopted turn.
              return true;
            }
            break;
          } catch {
            if (
              !(await waitForRetry(
                params.abortSignal,
                (params.retryDelay ?? retryDelayMs)(attempts),
              ))
            ) {
              return false;
            }
          }
        }
        if (params.abortSignal?.aborted) {
          return false;
        }
        const shouldRetry = await waitForRetry(
          params.abortSignal,
          (params.retryDelay ?? retryDelayMs)(attempts),
        );
        if (!shouldRetry) {
          return false;
        }
        continue;
      }
    }
    try {
      await params.journal.complete(params.id);
      return true;
    } catch {
      attempts += 1;
      // Dispatch already produced the agent turn. Keep the row pending and retry only the
      // idempotent completion marker; releasing and redispatching would duplicate the reply.
      const shouldRetry = await waitForRetry(
        params.abortSignal,
        (params.retryDelay ?? retryDelayMs)(attempts),
      );
      if (!shouldRetry) {
        return false;
      }
    }
  }
  return false;
}

export async function replayPendingAgentMailIngress(params: {
  journal: AgentMailJournal;
  dispatch: AgentMailIngressDispatch;
  abortSignal?: AbortSignal;
  retryDelayMs?: (attempt: number) => number;
}): Promise<void> {
  for (const pending of await params.journal.pending()) {
    scheduleAgentMailIngressDispatch({
      journal: params.journal,
      id: pending.id,
      record: pending.payload,
      dispatch: params.dispatch,
      abortSignal: params.abortSignal,
      retryDelay: params.retryDelayMs,
      initialAttempts: pending.attempts,
    });
  }
}
