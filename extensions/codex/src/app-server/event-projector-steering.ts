import { randomUUID } from "node:crypto";
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";

type SteeringAssistantPrefix = {
  itemId: string;
  text: string;
  completed: boolean;
  split: boolean;
  segment: number;
  occurrenceCount: number;
};

type AssistantOccurrences = {
  current?: string;
  ids: string[];
  ownedCount: number;
};

/** Owns the raw assistant cutoffs committed before each steer in one native turn. */
export class CodexSteeringAssistantSegments {
  streamedPartialAssistantItemId: string | undefined;
  private streamedPartialAssistantItemReplaceable = false;
  private readonly visible = new Set<string>();
  private readonly completed = new Map<string, number>();
  private readonly handoffItems = new Set<string>();
  private handoffGeneration = 0;
  private readonly persisted = new Map<string, { text: string; nextSegment: number }>();
  private readonly pending = new Map<string, SteeringAssistantPrefix>();
  private readonly occurrences = new Map<string, AssistantOccurrences>();
  private readonly receiptIds = new Map<string, readonly string[]>();

  beginSnapshot(): void {
    this.pending.clear();
  }

  recordStream(itemId: string, knownFinalAnswer: boolean) {
    const replace =
      this.streamedPartialAssistantItemId !== undefined &&
      this.streamedPartialAssistantItemId !== itemId;
    // Codex defines final_answer as terminal text. Replacement mode is for
    // phase-unknown/provisional items; append-only consumers cannot retract bytes.
    if (replace && (!knownFinalAnswer || this.streamedPartialAssistantItemReplaceable)) {
      this.streamedPartialAssistantItemReplaceable = true;
    } else if (this.streamedPartialAssistantItemId === undefined) {
      this.streamedPartialAssistantItemReplaceable = !knownFinalAnswer;
    }
    this.streamedPartialAssistantItemId = itemId;
    const replaceable = this.streamedPartialAssistantItemReplaceable;
    const replacement = replace && replaceable;
    if (replacement) {
      this.visible.clear();
    }
    this.visible.add(itemId);
    let occurrence = this.occurrences.get(itemId);
    if (!occurrence) {
      occurrence = { ids: [], ownedCount: 0 };
      this.occurrences.set(itemId, occurrence);
    }
    if (!occurrence.current) {
      occurrence.current = randomUUID();
      occurrence.ids.push(occurrence.current);
    }
    return { occurrenceId: occurrence.current, replacement, replaceable };
  }

  clearProvisionalStream(itemId: string) {
    if (
      this.streamedPartialAssistantItemId === itemId &&
      this.streamedPartialAssistantItemReplaceable
    ) {
      this.streamedPartialAssistantItemId = undefined;
      const occurrence = this.occurrences.get(itemId);
      return {
        itemId,
        occurrenceId: occurrence?.current ?? occurrence?.ids.at(-1),
        text: "",
        delta: "",
        replace: true as const,
      };
    }
    return undefined;
  }

  collectOccurrenceIds(itemIds: readonly string[]): string[] {
    return [...new Set(itemIds.flatMap((itemId) => this.occurrences.get(itemId)?.ids ?? []))];
  }

  isVisible(itemId: string): boolean {
    return this.visible.has(itemId);
  }

  recordCompletion(itemId: string): void {
    // Replays cannot move a completed answer past a later native handoff.
    if (!this.completed.has(itemId)) {
      this.completed.set(itemId, this.handoffGeneration);
    }
  }

  isCompleted(itemId: string): boolean {
    return this.completed.has(itemId);
  }

  recordHandoff(itemId: string): boolean {
    if (itemId && this.handoffItems.has(itemId)) {
      return false;
    }
    if (itemId) {
      this.handoffItems.add(itemId);
    }
    this.handoffGeneration += 1;
    return true;
  }

  survivesHandoff(itemId: string): boolean {
    const completedAt = this.completed.get(itemId);
    return (
      this.persisted.has(itemId) &&
      (completedAt === undefined || completedAt >= this.handoffGeneration)
    );
  }

  remainingText(itemId: string, text: string): string {
    const prefix = this.persisted.get(itemId);
    return prefix && text.startsWith(prefix.text) ? text.slice(prefix.text.length) : text;
  }

  capture(
    itemId: string,
    text: string | undefined,
    completed: boolean,
  ):
    | { itemId: string; text: string; split: boolean; occurrenceIds: readonly string[] }
    | undefined {
    if (text === undefined) {
      return undefined;
    }
    const remainder = this.remainingText(itemId, text);
    if (!remainder.trim() || isSilentReplyPayloadText(remainder)) {
      return undefined;
    }
    const prefix = this.persisted.get(itemId);
    const split = prefix !== undefined || !completed;
    const segment = prefix?.nextSegment ?? 0;
    const mirrorItemId = split ? `${itemId}:segment:${segment}` : itemId;
    const occurrence = this.occurrences.get(itemId);
    const unownedIds = occurrence?.ids.slice(occurrence.ownedCount) ?? [];
    const occurrenceIds = unownedIds.length
      ? unownedIds
      : (this.receiptIds.get(mirrorItemId) ?? []);
    this.receiptIds.set(mirrorItemId, occurrenceIds);
    this.pending.set(mirrorItemId, {
      itemId,
      text,
      completed,
      split,
      segment,
      occurrenceCount: occurrence?.ids.length ?? 0,
    });
    // The commit awaits I/O. Bytes arriving after this capture must belong to
    // another occurrence even before the captured candidate becomes durable.
    if (occurrence) {
      delete occurrence.current;
    }
    return { itemId: mirrorItemId, text: remainder, split, occurrenceIds };
  }

  consume(mirrorItemId: string): { itemId: string; completed: boolean } | undefined {
    const prefix = this.pending.get(mirrorItemId);
    if (!prefix) {
      return undefined;
    }
    this.pending.delete(mirrorItemId);
    const occurrence = this.occurrences.get(prefix.itemId);
    if (occurrence) {
      occurrence.ownedCount = Math.max(occurrence.ownedCount, prefix.occurrenceCount);
    }
    if (prefix.split) {
      // Each committed candidate owns its captured bytes even if a later write fails.
      this.persisted.set(prefix.itemId, {
        text: prefix.text,
        nextSegment: prefix.segment + 1,
      });
    }
    return { itemId: prefix.itemId, completed: prefix.completed };
  }

  adoptCompletion(sourceId: string, itemId: string, text: string, sourceText?: string): boolean {
    const pending = [...this.pending.values()].find((prefix) => prefix.itemId === sourceId);
    const persisted = this.persisted.get(sourceId);
    const prefix = pending?.text ?? persisted?.text ?? sourceText;
    if (!prefix || !text.startsWith(prefix)) {
      return false;
    }
    if (persisted) {
      this.persisted.set(itemId, persisted);
    }
    const occurrence = this.occurrences.get(sourceId);
    if (occurrence) {
      this.occurrences.set(itemId, occurrence);
    }
    if (pending) {
      pending.itemId = itemId;
    }
    this.visible.delete(sourceId);
    return true;
  }
}
