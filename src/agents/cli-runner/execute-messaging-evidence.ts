/**
 * The bounded holder for delivery evidence of message sends whose result has
 * not arrived yet.
 *
 * It is the third holder of a tool start's decoded arguments, beside the event
 * consumer's `toolArgsByCallId` and the tracking's `activeCliTools`, and it is
 * the one that outlives both: a pending send keeps its arguments until a result
 * settles the delivery. Bounded in count by `CLI_MESSAGING_EVIDENCE_MAX_CALLS`
 * and in bytes by the run's single retention decision — an entry holds the full
 * arguments only while those same arguments are charged to the consumer's
 * aggregate cap, and is reduced to its routing facts as soon as that cap refuses
 * or evicts them.
 *
 * Lives beside `execute-event-retention.ts` for the same reason its caps do:
 * every holder of one decoded object has to agree about when to let go, or
 * bounding any of them frees nothing.
 */
import type { MessagingToolSend } from "../embedded-agent-messaging.types.js";
import { measureToolArgChars, reduceMessagingToolArgs } from "./execute-event-retention.js";
import { CLI_MESSAGING_EVIDENCE_MAX_CALLS } from "./execute-messaging.js";

export type PendingMessagingCall = {
  toolName: string;
  args: Record<string, unknown>;
  target?: MessagingToolSend;
  /**
   * The payload was released. Whatever this entry can still prove, it proves
   * from routing facts alone — so anything that would have been decided by
   * reading the arguments has to take its conservative branch.
   */
  argsReduced?: true;
};

export function createPendingMessagingCalls() {
  const calls = new Map<string, PendingMessagingCall>();
  let reducedCalls = 0;
  let reducedArgChars = 0;
  const release = (toolCallId: string): PendingMessagingCall | undefined => {
    const pending = calls.get(toolCallId);
    if (!pending) {
      return undefined;
    }
    if (pending.argsReduced) {
      reducedCalls -= 1;
      reducedArgChars -= measureToolArgChars(pending.args);
    }
    calls.delete(toolCallId);
    return pending;
  };
  return {
    get size(): number {
      return calls.size;
    },
    values: (): PendingMessagingCall[] => Array.from(calls.values()),
    release,
    /** Admits a send, evicting the oldest entry when the count cap is reached. */
    admit(toolCallId: string, call: PendingMessagingCall): { evicted: boolean } {
      let evicted = false;
      if (calls.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
        const oldestToolCallId = calls.keys().next().value;
        if (oldestToolCallId !== undefined) {
          release(oldestToolCallId);
          evicted = true;
        }
      }
      calls.set(toolCallId, call);
      return { evicted };
    },
    /** Releases this send's payload, keeping the facts that settle a real send. */
    reduce(toolCallId: string): void {
      const pending = calls.get(toolCallId);
      if (!pending || pending.argsReduced) {
        return;
      }
      const reduction = reduceMessagingToolArgs(pending.args);
      if (!reduction.reduced) {
        return;
      }
      pending.args = reduction.args;
      pending.argsReduced = true;
      reducedCalls += 1;
      reducedArgChars += reduction.chars;
    },
    sizes: () => ({
      pendingMessagingCalls: calls.size,
      reducedMessagingCalls: reducedCalls,
      reducedMessagingArgChars: reducedArgChars,
    }),
  };
}
