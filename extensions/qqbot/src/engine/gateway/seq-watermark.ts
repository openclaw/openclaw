/**
 * RESUME seq watermark — tracks in-flight message seqs so reconnect resume
 * never skips messages that were received but not yet fully processed.
 *
 * The QQ gateway replays only events with seq greater than the RESUME seq.
 * Committing a message frame's seq before its queued handler finishes turns
 * a restart, reconnect, or handler failure into permanent message loss.
 * The watermark therefore advances past a message seq only after that
 * message settles (handled successfully or intentionally dropped); frames
 * without queued work (HELLO acks, READY, interactions) commit immediately.
 */
export class SeqWatermark {
  private highestObserved: number | null = null;
  private pending = new Set<number>();

  /** Reset to a restored seq (or null when the session is discarded). */
  reset(seed: number | null): void {
    this.highestObserved = seed;
    this.pending.clear();
  }

  /** Record a frame whose seq may commit immediately (no queued work). */
  observe(seq: number): void {
    if (this.highestObserved === null || seq > this.highestObserved) {
      this.highestObserved = seq;
    }
  }

  /** Record a message frame whose seq must wait for its handler to settle. */
  register(seq: number): void {
    this.pending.add(seq);
    this.observe(seq);
  }

  /** Mark a registered message as settled (handled or intentionally dropped). */
  settle(seq: number): void {
    this.pending.delete(seq);
  }

  /**
   * Latest received frame seq, regardless of settlement. Heartbeats report
   * this receive cursor; using the resumable watermark there would make the
   * client look behind while a handler is still running.
   */
  latest(): number | null {
    return this.highestObserved;
  }

  /**
   * Resumable seq: the highest observed seq once nothing older is pending,
   * otherwise just below the oldest unsettled message so RESUME replays it.
   */
  value(): number | null {
    if (this.pending.size === 0) {
      return this.highestObserved;
    }
    let oldestPending: number | null = null;
    for (const seq of this.pending) {
      if (oldestPending === null || seq < oldestPending) {
        oldestPending = seq;
      }
    }
    return oldestPending === null ? this.highestObserved : oldestPending - 1;
  }
}
