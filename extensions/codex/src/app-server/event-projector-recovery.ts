import { isDeepStrictEqual } from "node:util";
import { readCodexAsyncQuestions } from "./async-questions.js";
import type { CodexThreadItem } from "./protocol.js";

export type CodexCompletedAssistantIdentity = {
  id: string;
  text: string;
  phase?: unknown;
  delivery?: unknown;
  questions?: unknown;
};

function sameMessage(
  left: CodexCompletedAssistantIdentity,
  right: CodexCompletedAssistantIdentity,
): boolean {
  return (
    left.text === right.text &&
    (left.phase ?? null) === (right.phase ?? null) &&
    (left.delivery ?? null) === (right.delivery ?? null) &&
    isDeepStrictEqual(
      readCodexAsyncQuestions(left.questions) ?? [],
      readCodexAsyncQuestions(right.questions) ?? [],
    )
  );
}

/**
 * Legacy native snapshots use item-N identities, whereas live events retain
 * canonical IDs. Only a unique ordered embedding can preserve existing mirrors.
 */
export function reconcileCodexRecoveredAssistantItems(params: {
  observed: readonly CodexCompletedAssistantIdentity[];
  items: readonly CodexThreadItem[];
  terminalAssistant?: CodexThreadItem;
}): CodexThreadItem[] {
  const snapshot = params.items.filter((item) => item.type === "agentMessage");
  const observed = [...params.observed];
  const previouslyObserved = new Set(observed.map((item) => item.id));
  const fail = () => new Error("Recovered Codex assistant history has ambiguous item identities");
  const summary = params.terminalAssistant;
  if (summary && !previouslyObserved.has(summary.id)) {
    observed.push(summary);
  }
  const snapshotIds = new Map(snapshot.map((item, index) => [item.id, index]));
  if (snapshotIds.size !== snapshot.length) {
    throw fail();
  }
  // Native terminal Summary contains the last nonempty final/phase-null message.
  const finalIndex = summary
    ? snapshot.findLastIndex(
        (item) =>
          item.text.trim() &&
          (item.phase === "final_answer" || item.phase === undefined || item.phase === null),
      )
    : -1;
  const matches = (index: number, candidate: number) => {
    const item = observed[index]!;
    const anchor = item.id === summary?.id ? finalIndex : snapshotIds.get(item.id);
    return (
      (anchor === undefined || anchor === candidate) && sameMessage(item, snapshot[candidate]!)
    );
  };
  const earliest: number[] = [];
  let cursor = 0;
  for (let index = 0; index < observed.length; index += 1) {
    while (cursor < snapshot.length && !matches(index, cursor)) {
      cursor += 1;
    }
    if (cursor === snapshot.length) {
      throw fail();
    }
    earliest.push(cursor++);
  }
  cursor = snapshot.length - 1;
  for (let index = observed.length - 1; index >= 0; index -= 1) {
    while (cursor >= 0 && !matches(index, cursor)) {
      cursor -= 1;
    }
    if (cursor !== earliest[index]) {
      throw fail();
    }
    cursor -= 1;
  }
  const aliases = new Map(earliest.map((index, ordinal) => [index, observed[ordinal]!.id]));
  let assistantIndex = 0;
  const items = params.items.map((item) => {
    if (item.type !== "agentMessage") {
      return item;
    }
    const id = aliases.get(assistantIndex++) ?? item.id;
    if (item.delivery === "async" && !previouslyObserved.has(id)) {
      throw new Error("Recovered Codex async delivery has no confirmed local item identity");
    }
    return id === item.id ? item : { ...item, id };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw fail();
  }
  return items;
}
