import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../types.js";

export type ToolCallLike = { id: string; name?: string };
type CallFact = ToolCallLike & { contentIndex: number };
export type ToolPairingMessageFact =
  | { role: "assistant"; calls: CallFact[]; failed: boolean }
  | { role: "toolResult"; id: string | null; name?: string; synthetic: boolean }
  | { role: "other" };
type ResultFact = { index: number; id: string | null; synthetic: boolean };
type OccurrenceFact = CallFact & { result?: ResultFact };
export type ToolPairingFrameFact = {
  startIndex: number;
  endIndex: number;
  occurrences: OccurrenceFact[];
  remainder: Array<{ index: number; id?: string | null }>;
  failed: boolean;
};

/** The identity is opaque: array adapters use message identity, readers use row identity. */
export function selectResetKeptMessageFacts<
  T extends {
    role: AgentMessage["role"];
    pairing: ToolPairingMessageFact | undefined;
    identity: unknown;
  },
>(messages: readonly T[]): T[] {
  const frames = classifyToolPairingFacts(messages.map((message) => message.pairing));
  const pairedResults = new Set(
    frames.flatMap((frame) =>
      frame.occurrences.flatMap((occurrence) =>
        occurrence.result ? [messages[occurrence.result.index]?.identity] : [],
      ),
    ),
  );
  return messages.filter(
    (message) =>
      message.role === "user" ||
      message.role === "assistant" ||
      (message.role === "toolResult" && pairedResults.has(message.identity)),
  );
}

/** Tracks repeated provider ids by occurrence instead of collapsing them into a set. */
export function createToolCallOccurrenceQueue<T>(): {
  add: (id: string, occurrence: T) => void;
  claim: (id: string) => T | undefined;
  clear: () => void;
  readonly size: number;
} {
  const pendingById = new Map<string, T[]>();
  let pendingCount = 0;
  return {
    add(id, occurrence) {
      const pending = pendingById.get(id);
      if (pending) {
        pending.push(occurrence);
      } else {
        pendingById.set(id, [occurrence]);
      }
      pendingCount += 1;
    },
    claim(id) {
      const pending = pendingById.get(id);
      const occurrence = pending?.shift();
      if (!occurrence) {
        return undefined;
      }
      pendingCount -= 1;
      if (pending?.length === 0) {
        pendingById.delete(id);
      }
      return occurrence;
    },
    clear() {
      pendingById.clear();
      pendingCount = 0;
    },
    get size() {
      return pendingCount;
    },
  };
}

export function resolveLegacyToolResultId(
  id: string | null,
  name: string | undefined,
  calls: readonly ToolCallLike[],
): string | null {
  if (id || calls.length !== 1) {
    return id;
  }
  const call = calls[0];
  if (!call) {
    return id;
  }
  const resultName = normalizeOptionalString(name);
  const callName = normalizeOptionalString(call.name);
  return resultName && callName && resultName !== callName ? id : call.id;
}

/** Payload-free occurrence ownership, shared by replay repair and compaction cuts. */
export function classifyToolPairingFacts(
  messages: readonly (ToolPairingMessageFact | undefined)[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolPairingFrameFact[] {
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const frames: Array<ToolPairingFrameFact & { unclaimedResults?: ResultFact[] }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.calls.length === 0) {
      continue;
    }
    const previous = frames.at(-1);
    if (previous) {
      previous.endIndex = index;
    }
    frames.push({
      startIndex: index,
      endIndex: messages.length,
      occurrences: message.calls.map((call) => ({ ...call })),
      remainder: [],
      failed: message.failed,
    });
  }
  const pending = createToolCallOccurrenceQueue<OccurrenceFact>();
  for (const frame of frames) {
    const { occurrences } = frame;
    pending.clear();
    for (const occurrence of occurrences) {
      pending.add(occurrence.id, occurrence);
    }
    for (let index = frame.startIndex + 1; index < frame.endIndex; index++) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      if (message.role !== "toolResult") {
        frame.remainder.push({ index });
        continue;
      }
      const id = resolveLegacyToolResultId(message.id, message.name, occurrences);
      const result = { index, id, synthetic: message.synthetic };
      const occurrence = id ? pending.claim(id) : undefined;
      if (occurrence) {
        occurrence.result = result;
        continue;
      }
      if (!id || !occurrences.some((candidate) => candidate.id === id)) {
        (frame.unclaimedResults ??= []).push(result);
        if (preserveUnframed) {
          frame.remainder.push({ index, id });
        }
        continue;
      }
      const replaceable = result.synthetic
        ? undefined
        : occurrences.find((candidate) => candidate.id === id && candidate.result?.synthetic);
      if (replaceable) {
        replaceable.result = result;
      }
    }
  }
  // A displaced result crosses a frame only when one unresolved occurrence can own it.
  let unresolvedById: Map<string, OccurrenceFact[]> | undefined;
  for (const frame of frames) {
    for (const occurrence of frame.occurrences) {
      if (!occurrence.result || occurrence.result.synthetic) {
        unresolvedById ??= new Map();
        const unresolved = unresolvedById.get(occurrence.id);
        if (unresolved) {
          unresolved.push(occurrence);
        } else {
          unresolvedById.set(occurrence.id, [occurrence]);
        }
      }
    }
    for (const result of frame.unclaimedResults ?? []) {
      const candidates = result.id
        ? unresolvedById
            ?.get(result.id)
            ?.filter(
              (candidate) => !candidate.result || (candidate.result.synthetic && !result.synthetic),
            )
        : undefined;
      const candidate = candidates?.length === 1 ? candidates[0] : undefined;
      if (candidate) {
        candidate.result = result;
        if (preserveUnframed) {
          frame.remainder = frame.remainder.filter((entry) => entry.index !== result.index);
        }
      }
    }
  }
  return frames;
}
