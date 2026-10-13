import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readResponsesOutputIndex } from "../transports/openai-responses-stream-slots-internal.js";

export type ResponsesToolCallIdentity = { itemId?: string; callId?: string };

export type ResponsesToolCallState = ResponsesToolCallIdentity & {
  argumentStreamReliable: boolean;
  argumentsStreamed: boolean;
  outputIndex?: number;
};

type ResponsesToolCallEvent = {
  output_index?: unknown;
  item_id?: unknown;
};

function readEventIdentity(event: ResponsesToolCallEvent): ResponsesToolCallIdentity {
  return { itemId: normalizeOptionalString(event.item_id) };
}

export function readResponsesToolCallItemIdentity(item: {
  id?: unknown;
  call_id?: unknown;
}): ResponsesToolCallIdentity {
  return {
    itemId: normalizeOptionalString(item.id),
    callId: normalizeOptionalString(item.call_id),
  };
}

export function createResponsesToolCallTracker<TState extends ResponsesToolCallState>() {
  const indexedCalls = new Map<number, TState>();
  const unindexedCalls = new Set<TState>();

  const identitiesConflict = (state: TState, identity: ResponsesToolCallIdentity): boolean =>
    Boolean(
      (state.itemId && identity.itemId && state.itemId !== identity.itemId) ||
      (state.callId && identity.callId && state.callId !== identity.callId),
    );

  const sharesIdentity = (state: TState, identity: ResponsesToolCallIdentity): boolean =>
    Boolean(
      (state.itemId && identity.itemId && state.itemId === identity.itemId) ||
      (state.callId && identity.callId && state.callId === identity.callId),
    );

  const adoptIdentity = (state: TState, identity: ResponsesToolCallIdentity): TState => {
    state.itemId ??= identity.itemId;
    state.callId ??= identity.callId;
    return state;
  };

  const resolveCompatible = (
    candidates: Iterable<TState>,
    identity: ResponsesToolCallIdentity,
    allowUnmatchedIdentity: boolean,
  ): TState | undefined => {
    const uniqueCandidates = [...new Set(candidates)];
    if (!identity.itemId && !identity.callId) {
      return allowUnmatchedIdentity && uniqueCandidates.length === 1
        ? uniqueCandidates.at(0)
        : undefined;
    }
    const compatible = uniqueCandidates.filter((state) => !identitiesConflict(state, identity));
    const matches = compatible.filter((state) => sharesIdentity(state, identity));
    // Only a sole active call may adopt an identity it did not already know.
    // Parallel calls require a positive match so missing indices stay fail-closed.
    const matched =
      matches.length === 1
        ? matches.at(0)
        : allowUnmatchedIdentity && uniqueCandidates.length === 1
          ? compatible.at(0)
          : undefined;
    return matched ? adoptIdentity(matched, identity) : undefined;
  };

  return {
    register(event: ResponsesToolCallEvent, state: TState): void {
      const outputIndex = readResponsesOutputIndex(event);
      if (outputIndex === undefined) {
        unindexedCalls.add(state);
        return;
      }
      if (indexedCalls.has(outputIndex)) {
        throw new Error(`Responses stream reused active tool-call output index ${outputIndex}`);
      }
      state.outputIndex = outputIndex;
      indexedCalls.set(outputIndex, state);
    },

    resolve(
      event: ResponsesToolCallEvent,
      identity: ResponsesToolCallIdentity = readEventIdentity(event),
      allowUnmatchedIdentity = true,
    ): TState | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      if (outputIndex !== undefined) {
        const indexed = indexedCalls.get(outputIndex);
        if (indexed) {
          if (indexed.callId && identity.callId && indexed.callId !== identity.callId) {
            return undefined;
          }
          // output_index owns routing once registered, but call_id stays stable;
          // compatible providers may rotate item_id for the same output item.
          return adoptIdentity(indexed, identity);
        }

        // A compatibility stream may add calls without indices, then start
        // including them. Bind only the one identity-matched (or sole) candidate.
        const unindexed = resolveCompatible(unindexedCalls, identity, allowUnmatchedIdentity);
        if (unindexed) {
          unindexedCalls.delete(unindexed);
          unindexed.outputIndex = outputIndex;
          indexedCalls.set(outputIndex, unindexed);
        }
        return unindexed;
      }

      return resolveCompatible(
        [...indexedCalls.values(), ...unindexedCalls],
        identity,
        allowUnmatchedIdentity,
      );
    },

    forget(toolCall: TState): void {
      for (const [outputIndex, tracked] of indexedCalls) {
        if (tracked === toolCall) {
          indexedCalls.delete(outputIndex);
        }
      }
      unindexedCalls.delete(toolCall);
    },

    markArgumentsUnreliable(): void {
      // An unrouteable argument event may belong to any active call. Only an
      // authoritative full argument snapshot can recover that call.
      for (const toolCall of new Set([...indexedCalls.values(), ...unindexedCalls])) {
        toolCall.argumentStreamReliable = false;
      }
    },

    hasActive(): boolean {
      return indexedCalls.size > 0 || unindexedCalls.size > 0;
    },

    values(): TState[] {
      return [...new Set([...indexedCalls.values(), ...unindexedCalls])];
    },

    hasExactlyActive(expected: readonly TState[]): boolean {
      const active = new Set([...indexedCalls.values(), ...unindexedCalls]);
      return active.size === expected.length && expected.every((state) => active.has(state));
    },
  };
}
