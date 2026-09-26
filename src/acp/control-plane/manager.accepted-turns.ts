/** Owns each admitted turn from actor admission through final settlement. */
import { createDeferredCore } from "../../shared/deferred.js";
import type { AcpRunTurnInput, ActiveTurnState, WithManagerSessionActor } from "./manager.types.js";
import { acpSessionActorKey } from "./manager.utils.js";

export type AcceptedTurnState = Pick<
  ActiveTurnState,
  "requestId" | "instanceId" | "abortController"
> & {
  activeTurn?: ActiveTurnState;
  settled: Promise<void>;
  cancelReason?: string;
  revalidateCancel?: () => void;
};

export type AcceptedTurns = Map<string, Set<AcceptedTurnState>>;

export async function runAcceptedManagerTurn(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  agentId: string;
  stopping: boolean;
  turns: AcceptedTurns;
  withSessionActor: WithManagerSessionActor;
  run: (
    input: AcpRunTurnInput,
    acceptedTurn: AcceptedTurnState,
    isCurrentActor: () => boolean,
  ) => Promise<void>;
  onQueuedCancellation: (assertCurrent: () => void) => Promise<void>;
}): Promise<void> {
  const { input } = params;
  const instance = input.admittedRunContext.operationalRunInstance;
  if (instance.runId !== input.requestId) {
    throw new Error("ACP operational run instance disagrees with the admitted request");
  }
  const completion = createDeferredCore();
  // Only cancellation joins this promise. Ordinary failed turns may have no joiner.
  void completion.promise.catch(() => {});
  const turn: AcceptedTurnState = {
    requestId: input.requestId,
    instanceId: instance.instanceId,
    abortController: new AbortController(),
    settled: completion.promise,
  };
  const actorKey = acpSessionActorKey(params);
  const turns = params.turns.get(actorKey) ?? new Set<AcceptedTurnState>();
  turns.add(turn);
  params.turns.set(actorKey, turns);
  if (params.stopping) {
    turn.abortController.abort();
  }
  const signal = input.signal
    ? AbortSignal.any([input.signal, turn.abortController.signal])
    : turn.abortController.signal;
  let started = false;
  try {
    try {
      await params.withSessionActor(
        params,
        async (isCurrentActor) => {
          started = true;
          await params.run({ ...input, signal }, turn, isCurrentActor);
        },
        signal,
      );
    } catch (error) {
      if (started || !signal.aborted) {
        throw error;
      }
      // The actor still owns its queued callback, which will observe the abort.
      // Finish only this accepted instance; never write idle over its predecessor.
      const assertCancellationCurrent = () => {
        if (started || params.turns.get(actorKey) !== turns || !turns.has(turn)) {
          throw new Error("ACP queued cancellation no longer owns its accepted turn", {
            cause: error,
          });
        }
        turn.revalidateCancel?.();
      };
      assertCancellationCurrent();
      await params.onQueuedCancellation(assertCancellationCurrent);
    }
    completion.resolve();
  } catch (error) {
    completion.reject(error);
    throw error;
  } finally {
    turns.delete(turn);
    if (turns.size === 0 && params.turns.get(actorKey) === turns) {
      params.turns.delete(actorKey);
    }
  }
}
