import { isOpenClawSystemUpdateMessage } from "./operator-messages.js";
import type { AgentMessage, QueueMode } from "./types.js";

export class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  onChange: (() => void) | undefined;
  private readonly inputListeners = new Set<() => void>();
  private readonly submitted = new Set<AgentMessage>();
  // Drained messages stay owned here until message_end commits them.
  // A failed run restores them ahead of messages accepted later.
  private inFlight: AgentMessage[] = [];
  private cancelled = new WeakSet<AgentMessage>();
  public mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.admit(message)();
  }

  admit(message: AgentMessage): () => void {
    this.messages.push(message);
    return () => {
      const errors: unknown[] = [];
      const listeners = this.onChange
        ? [this.onChange, ...this.inputListeners]
        : [...this.inputListeners];
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Steering notifications failed");
      }
    };
  }

  subscribe(listener: () => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  peek(): readonly AgentMessage[] {
    // A tool checkpoint fixes the next injection batch while the response is live.
    // Later input must wait for that batch to commit before it can reach the provider.
    const messages = (this.inFlight.length > 0 ? this.inFlight : this.messages).filter(
      (message) => !isOpenClawSystemUpdateMessage(message),
    );
    return messages.slice(0, this.mode === "all" ? undefined : 1);
  }

  reserve(messages: readonly AgentMessage[]): () => void {
    for (const message of messages) {
      this.submitted.add(message);
    }
    return () => {
      for (const message of messages) {
        this.submitted.delete(message);
      }
    };
  }

  hasItems(): boolean {
    return this.messages.some((message) => !isOpenClawSystemUpdateMessage(message));
  }

  drain(): AgentMessage[] {
    const input = this.messages.filter((message) => !isOpenClawSystemUpdateMessage(message));
    let count = this.mode === "all" ? input.length : 1;
    // Submitted input already belongs to one provider continuation. Later queued
    // messages must not rewrite that continuation's context before it completes.
    const boundary = input.findIndex((message) => !this.submitted.has(message));
    if (boundary > 0) {
      count = Math.min(count, boundary);
    }
    return this.drainMatching(count, (message) => !isOpenClawSystemUpdateMessage(message));
  }

  drainContext(): AgentMessage[] {
    // Operator context accompanies admitted input; it never starts a turn itself.
    return this.drainMatching(Infinity, isOpenClawSystemUpdateMessage);
  }

  private drainMatching(
    count: number,
    matches: (message: AgentMessage) => boolean,
  ): AgentMessage[] {
    const drained: AgentMessage[] = [];
    this.messages = this.messages.filter((message) => {
      if (drained.length >= count || !matches(message)) {
        return true;
      }
      drained.push(message);
      return false;
    });
    this.inFlight.push(...drained);
    return drained;
  }

  commit(message: AgentMessage): void {
    this.submitted.delete(message);
    this.cancelled.delete(message);
    const index = this.inFlight.indexOf(message);
    if (index >= 0) {
      this.inFlight.splice(index, 1);
    }
  }

  restore(): void {
    this.messages = [...this.inFlight, ...this.messages];
    this.inFlight = [];
    // Admission fences belong to the closed run. Preserve unsaved input for
    // recovery without retaining authority over its later cancellation.
    this.submitted.clear();
  }

  cancelFirst(predicate: (message: AgentMessage) => boolean): AgentMessage | undefined {
    const pendingIndex = this.messages.findIndex(predicate);
    const pendingMessage = this.messages[pendingIndex];
    if (pendingMessage) {
      // Provider-admitted input cannot be withdrawn. Retain its local queue
      // owner until the ordinary transcript boundary commits the same message.
      if (this.submitted.has(pendingMessage)) {
        return undefined;
      }
      return this.messages.splice(pendingIndex, 1)[0];
    }
    const inFlightIndex = this.inFlight.findIndex(predicate);
    const message = this.inFlight[inFlightIndex];
    if (!message || this.submitted.has(message)) {
      return undefined;
    }
    this.inFlight.splice(inFlightIndex, 1);
    // The loop may already hold this object after draining; retain a cancellation
    // fact until its next injection checkpoint so it cannot outlive queue ownership.
    this.cancelled.add(message);
    return message;
  }

  consumeCancellation(message: AgentMessage): boolean {
    return this.cancelled.delete(message);
  }

  clear(): void {
    this.messages = this.messages.filter((message) => this.submitted.has(message));
    this.inFlight = this.inFlight.filter((message) => this.submitted.has(message));
    this.cancelled = new WeakSet<AgentMessage>();
  }
}
