// Realtime telephony audio pacing for mulaw streams.
import { randomUUID } from "node:crypto";

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
// The lead absorbs event-loop timer lateness and network jitter in the telephony edge buffer.
// Barge-in clear flushes both queues, so this cushion does not add interruption latency.
const LEAD_MS = 160;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const QUEUE_COMPACT_HEAD_THRESHOLD = 256;
const MAX_PLAYBACK_SEGMENTS = 128;
const MAX_PENDING_MARK_BOUNDARIES = 64;

/** Queue item sent over the realtime provider media stream. */
type RealtimeAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      segment: RealtimePlaybackSegment;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

/** Retained playout accounting for one run of same-item provider audio. */
type RealtimePlaybackSegment = {
  itemId?: string;
  totalMs: number;
  sentMs: number;
  /** Cumulative send position of the segment's last sent frame. */
  lastSentEndMs?: number;
};

/** Send-time snapshot binding a carrier mark to the playback prefix before it. */
type RealtimeMarkBoundary = {
  name: string;
  sentMs: number;
};

/** WebSocket send callback for realtime audio frames. */
type RealtimeAudioSend = (message: string) => boolean;

/** Provider-specific serializer for media, clear, and mark frames. */
interface RealtimeAudioSerializer {
  media(payloadBase64: string): string;
  clear(): string;
  mark(name: string): string;
}

/** Paces outgoing mulaw audio frames at telephony cadence. */
export class RealtimeAudioPacer {
  private queue: RealtimeAudioQueueItem[] = [];
  private queueHead = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;
  private streamClockMs: number | null = null;
  private playbackSegments: RealtimePlaybackSegment[] = [];
  private sentAudioMs = 0;
  private retiredAudioMs = 0;
  private confirmedPlayedMs = 0;
  private readonly playbackMarkPrefix = `openclaw-playout-${randomUUID()}`;
  private playbackMarkSequence = 0;
  private lastPlaybackMarkMs = 0;
  private markBoundaries: RealtimeMarkBoundary[] = [];
  private retiredItemOffsets = new Map<string, number>();

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      /** Fires whenever queued audio and playback state are discarded. */
      onPlaybackReset?: () => void;
      send: RealtimeAudioSend;
      serializer: RealtimeAudioSerializer;
    },
  ) {}

  /** Queue mulaw audio and split it into 20ms-ish telephony chunks. */
  sendAudio(muLaw: Buffer, metadata?: { itemId?: string }): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        this.failBackpressure();
        return;
      }
      const durationMs = chunk.length / 8;
      const segment = this.extendPlaybackSegment(metadata?.itemId, durationMs);
      if (!segment) {
        // Retention is at capacity with live segments. Losing a queued item's
        // playback identity would corrupt interruption accounting, so tear
        // down through the existing backpressure path instead of admitting it.
        this.failBackpressure();
        return;
      }
      this.queue.push({
        type: "audio",
        chunk,
        durationMs,
        segment,
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
  }

  /**
   * Retained provider items in playback order with consumed playout duration.
   * Queued audio has not reached the telephony line, so unplayed items report zero.
   */
  getPlaybackState(): { itemId: string; audioEndMs: number }[] {
    let remaining = Math.max(0, this.confirmedPlayedMs - this.retiredAudioMs);
    const playedByItem = new Map<string, number>();
    for (const segment of this.playbackSegments) {
      const consumed = Math.min(remaining, segment.sentMs);
      remaining -= consumed;
      if (segment.itemId !== undefined) {
        const previousMs =
          playedByItem.get(segment.itemId) ?? this.retiredItemOffsets.get(segment.itemId) ?? 0;
        playedByItem.set(segment.itemId, previousMs + consumed);
      }
    }
    return Array.from(playedByItem, ([itemId, audioEndMs]) => ({
      itemId,
      audioEndMs: Math.floor(audioEndMs),
    }));
  }

  /** Queue a provider mark frame after prior audio frames. */
  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  /** Retire the playback prefix once the carrier confirms playout reached the mark. */
  acknowledgeMark(name?: string): void {
    if (this.closed || !name) {
      return;
    }
    const boundaryIndex = this.markBoundaries.findIndex((boundary) => boundary.name === name);
    if (boundaryIndex < 0) {
      return;
    }
    // Carrier marks fire in send order, so every earlier boundary retires too.
    const boundary = this.markBoundaries[boundaryIndex];
    this.markBoundaries.splice(0, boundaryIndex + 1);
    if (!boundary) {
      return;
    }
    // Progress marks can confirm a prefix while the same item still has queued audio.
    while (this.playbackSegments.length > 0) {
      const head = this.playbackSegments[0];
      if (
        !head ||
        head.sentMs < head.totalMs ||
        head.lastSentEndMs === undefined ||
        head.lastSentEndMs > boundary.sentMs
      ) {
        break;
      }
      const retired = this.playbackSegments.shift();
      if (retired) {
        this.retiredAudioMs += retired.sentMs;
        // Providers may resume the same item after a chunk acknowledgement;
        // keep its cumulative played offset so later snapshots do not restart
        // at zero.
        if (retired.itemId !== undefined) {
          this.retiredItemOffsets.set(
            retired.itemId,
            (this.retiredItemOffsets.get(retired.itemId) ?? 0) + retired.sentMs,
          );
        }
      }
    }
    this.confirmedPlayedMs = Math.max(
      this.confirmedPlayedMs,
      Math.min(boundary.sentMs, this.sentAudioMs),
    );
  }

  /** Clear queued audio and notify the provider stream. */
  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.clearTimer();
    this.resetQueue();
    this.resetPlaybackState();
    this.params.send(this.params.serializer.clear());
    return clearedAudioBytes;
  }

  /** True while queued audio or a paced send timer can still reach the telephony stream. */
  hasPendingAudio(): boolean {
    return !this.closed && (this.queuedAudioBytes > 0 || this.timer !== null);
  }

  /** Stop sending and discard queued frames. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.resetQueue();
    this.resetPlaybackState();
  }

  private extendPlaybackSegment(
    itemId: string | undefined,
    durationMs: number,
  ): RealtimePlaybackSegment | null {
    let segment = this.playbackSegments.at(-1);
    if (!segment || segment.itemId !== itemId) {
      if (this.playbackSegments.length >= MAX_PLAYBACK_SEGMENTS) {
        return null;
      }
      segment = { itemId, totalMs: 0, sentMs: 0 };
      this.playbackSegments.push(segment);
    }
    segment.totalMs += durationMs;
    return segment;
  }

  private resetPlaybackState(): void {
    this.playbackSegments = [];
    this.queuedAudioBytes = 0;
    this.sentAudioMs = 0;
    this.retiredAudioMs = 0;
    this.confirmedPlayedMs = 0;
    this.lastPlaybackMarkMs = 0;
    this.markBoundaries = [];
    this.retiredItemOffsets.clear();
    this.streamClockMs = null;
    this.params.onPlaybackReset?.();
  }

  /** Clear the scheduled pump timer. */
  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Start the pump when queued work exists and no timer is active. */
  private ensurePump(): void {
    if (!this.timer) {
      this.pump();
    }
  }

  /** Close the pacer and notify the caller about queued-audio backpressure. */
  private failBackpressure(): void {
    this.close();
    this.params.onBackpressure?.();
  }

  private get pendingQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  /** Take one queued item without shifting the remaining paced-audio backlog. */
  private takeNextItem(): RealtimeAudioQueueItem | undefined {
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
      return undefined;
    }
    const item = this.queue[this.queueHead];
    this.queueHead += 1;
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
    } else if (
      this.queueHead > QUEUE_COMPACT_HEAD_THRESHOLD &&
      this.queueHead * 2 > this.queue.length
    ) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return item;
  }

  private resetQueue(): void {
    this.queue.length = 0;
    this.queueHead = 0;
  }

  /** Fill the provider playout cushion, then wake at the next timeline boundary. */
  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const now = performance.now();
    this.streamClockMs ??= now;

    while (this.pendingQueueSize > 0 && this.streamClockMs < now + LEAD_MS) {
      const item = this.takeNextItem();
      if (!item) {
        break;
      }

      const sent = item.type === "audio" ? this.sendAudioItem(item) : this.sendMarkItem(item);
      if (!sent) {
        this.resetQueue();
        this.queuedAudioBytes = 0;
        this.streamClockMs = null;
        return;
      }
    }

    if (this.pendingQueueSize === 0) {
      this.streamClockMs = null;
      return;
    }
    const delayMs = Math.max(1, this.streamClockMs - LEAD_MS - performance.now());
    this.timer = setTimeout(() => this.pump(), delayMs);
  }

  private sendAudioItem(item: Extract<RealtimeAudioQueueItem, { type: "audio" }>): boolean {
    this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
    const sent = this.params.send(this.params.serializer.media(item.chunk.toString("base64")));
    if (sent) {
      item.segment.sentMs += item.durationMs;
      this.sentAudioMs += item.durationMs;
      item.segment.lastSentEndMs = this.sentAudioMs;
    }
    this.streamClockMs = (this.streamClockMs ?? performance.now()) + item.durationMs;
    if (
      !sent ||
      item.segment.itemId === undefined ||
      this.sentAudioMs - this.lastPlaybackMarkMs < LEAD_MS
    ) {
      return sent;
    }
    // Confirm playout during long provider chunks, before their final provider mark.
    this.lastPlaybackMarkMs = this.sentAudioMs;
    this.playbackMarkSequence += 1;
    return this.sendMarkItem({
      type: "mark",
      name: `${this.playbackMarkPrefix}-${this.playbackMarkSequence}`,
    });
  }

  /** Send a queued mark frame and bind it to the playback prefix before it. */
  private sendMarkItem(item: Extract<RealtimeAudioQueueItem, { type: "mark" }>): boolean {
    const sent = this.params.send(this.params.serializer.mark(item.name));
    if (sent) {
      this.markBoundaries.push({
        name: item.name,
        sentMs: this.sentAudioMs,
      });
      if (this.markBoundaries.length > MAX_PENDING_MARK_BOUNDARIES) {
        this.markBoundaries.shift();
      }
    }
    return sent;
  }
}
