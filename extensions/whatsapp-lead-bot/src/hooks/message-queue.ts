/**
 * Message Queue - manages pending messages when agent sends multiple in one response
 */

interface QueuedMessage {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
  accountId?: string;
  delayMs?: number;
}

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();

  /**
   * Add message to queue for a recipient
   */
  add(to: string, message: QueuedMessage): void {
    const key = this.getQueueKey(to, message.accountId);
    if (!this.queues.has(key)) {
      this.queues.set(key, []);
    }
    this.queues.get(key)!.push(message);
    console.log(
      `[message-queue] Added message to queue for ${to}, queue size: ${this.queues.get(key)!.length}`,
    );
  }

  /**
   * Get and remove the next message from queue
   */
  pop(to: string, accountId?: string): QueuedMessage | undefined {
    const key = this.getQueueKey(to, accountId);
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const message = queue.shift();
    if (queue.length === 0) {
      this.queues.delete(key);
    }
    return message;
  }

  /**
   * Check if there are queued messages for a recipient
   */
  hasQueued(to: string, accountId?: string): boolean {
    const key = this.getQueueKey(to, accountId);
    const queue = this.queues.get(key);
    return queue !== undefined && queue.length > 0;
  }

  /**
   * Get queue size for a recipient
   */
  queueSize(to: string, accountId?: string): number {
    const key = this.getQueueKey(to, accountId);
    const queue = this.queues.get(key);
    return queue ? queue.length : 0;
  }

  /**
   * Clear all queues
   */
  clear(): void {
    this.queues.clear();
  }

  private getQueueKey(to: string, accountId?: string): string {
    return `${to}:${accountId || "default"}`;
  }
}
