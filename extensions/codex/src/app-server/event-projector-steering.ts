import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";

type SteeringAssistantPrefix = {
  itemId: string;
  text: string;
  completed: boolean;
  split: boolean;
  segment: number;
};

/** Owns the raw assistant cutoffs committed before each steer in one native turn. */
export class CodexSteeringAssistantSegments {
  private readonly visible = new Set<string>();
  private readonly completed = new Map<string, number>();
  private readonly handoffItems = new Set<string>();
  private handoffGeneration = 0;
  private readonly persisted = new Map<string, { text: string; nextSegment: number }>();
  private readonly pending = new Map<string, SteeringAssistantPrefix>();

  beginSnapshot(): void {
    this.pending.clear();
  }

  recordStream(itemId: string, replacement: boolean): void {
    if (replacement) {
      this.visible.clear();
    }
    this.visible.add(itemId);
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
  ): { itemId: string; text: string; split: boolean } | undefined {
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
    this.pending.set(mirrorItemId, { itemId, text, completed, split, segment });
    return { itemId: mirrorItemId, text: remainder, split };
  }

  consume(mirrorItemId: string): { itemId: string; completed: boolean } | undefined {
    const prefix = this.pending.get(mirrorItemId);
    if (!prefix) {
      return undefined;
    }
    this.pending.delete(mirrorItemId);
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
    if (pending) {
      pending.itemId = itemId;
    }
    this.visible.delete(sourceId);
    return true;
  }
}
