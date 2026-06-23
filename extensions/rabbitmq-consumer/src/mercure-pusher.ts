import { sanitizeInternalRefs } from "./sanitize-output.js";
import type { ActivityStep } from "./tool-activity.js";
import type { MercureConfig } from "./types.js";

/**
 * Mercure Hub push client.
 *
 * Ported from Python mercure_manager.py MercureManager.
 * Uses Node.js native fetch() to POST to the Mercure Hub.
 */
export class MercurePusher {
  private readonly hubUrl: string;
  private readonly jwtSecret: string;

  constructor(config: MercureConfig) {
    this.hubUrl = config.hubUrl;
    this.jwtSecret = config.jwtSecret;
  }

  /**
   * Generate a publisher JWT token (HS256).
   * Uses the Web Crypto API available in Node 22+.
   */
  private async generatePublisherJwt(): Promise<string> {
    const encoder = new TextEncoder();

    const header = encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = encoder.encode(JSON.stringify({ mercure: { publish: ["*"] } }));

    const headerB64 = this.base64UrlEncode(header);
    const payloadB64 = this.base64UrlEncode(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
    const signatureB64 = this.base64UrlEncode(new Uint8Array(signature));

    return `${signingInput}.${signatureB64}`;
  }

  private base64UrlEncode(data: Uint8Array | ArrayBuffer): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * Push a text chunk (typewriter effect).
   * `historyId` tags the chunk with its originating chat turn so the frontend
   * can drop chunks that belong to another turn (stale SSE subscriptions on
   * the shared per-user topic used to render them into old bubbles).
   */
  async pushText(topic: string, content: string, historyId?: number): Promise<boolean> {
    return this.sendToMercure(topic, {
      type: "text",
      content,
      ...(historyId === undefined ? {} : { historyId }),
    });
  }

  /**
   * Push a sanitized activity status line (e.g. "正在查询分析数据（第 2 步）…").
   * Typed `progress` (not `text`) so the frontend renders it as a transient
   * "working" indicator instead of appending it to the reply bubble.
   */
  async pushProgress(topic: string, content: string, historyId?: number): Promise<boolean> {
    return this.sendToMercure(topic, {
      type: "progress",
      content,
      ...(historyId === undefined ? {} : { historyId }),
    });
  }

  /**
   * Push a structured timeline step (start/end) for the frontend's collapsible
   * "工作过程" panel. Typed `step` so the frontend appends it to the assistant
   * message's step list instead of the reply body. Carries only the sanitized
   * label/category from the narrator — never tool args.
   */
  async pushStep(topic: string, step: ActivityStep, historyId?: number): Promise<boolean> {
    return this.sendToMercure(topic, {
      type: "step",
      ...step,
      ...(historyId === undefined ? {} : { historyId }),
    });
  }

  /** Push a done signal (frontend stops animation), tagged with the chat turn. */
  async pushDone(topic: string, historyId?: number): Promise<boolean> {
    return this.sendToMercure(topic, {
      type: "done",
      ...(historyId === undefined ? {} : { historyId }),
    });
  }

  /**
   * Announce a queued report task so the frontend can render a placeholder
   * card immediately; later `report_text`/`report`/`report_done` events from
   * the report-generator carry the same taskId and update that card in place.
   */
  async pushReportCreated(topic: string, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_created", taskId });
  }

  /** Push an error signal, tagged with the chat turn. */
  async pushError(topic: string, error: string, historyId?: number): Promise<boolean> {
    return this.sendToMercure(topic, {
      type: "error",
      error,
      ...(historyId === undefined ? {} : { historyId }),
    });
  }

  private async sendToMercure(topic: string, data: Record<string, unknown>): Promise<boolean> {
    try {
      const token = await this.generatePublisherJwt();

      const params = new URLSearchParams();
      params.set("topic", topic);
      params.set("data", JSON.stringify(data));

      const response = await fetch(this.hubUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(30_000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Buffered streaming pusher that collects small text chunks and flushes
 * them as batched Mercure pushes, creating a typewriter effect.
 *
 * Mirrors the Python `_stream_response_with_mercure` pattern:
 * each LLM delta is forwarded to the frontend in near-real-time.
 */
export class StreamingMercurePusher {
  private readonly pusher: MercurePusher;
  private readonly topic: string;
  private readonly historyId: number | undefined;
  private readonly flushIntervalMs: number;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fullText = "";
  /**
   * Chains flushes so pushes always reach the hub in order. Without it, a
   * timer-scheduled flush still in flight races the `done` POST from
   * `finish()`; when `done` wins, the frontend finalizes the bubble and drops
   * the late tail chunk (reply truncated mid-sentence).
   */
  private pending: Promise<void> = Promise.resolve();

  constructor(pusher: MercurePusher, topic: string, historyId?: number, flushIntervalMs = 80) {
    this.pusher = pusher;
    this.topic = topic;
    this.historyId = historyId;
    this.flushIntervalMs = flushIntervalMs;
  }

  /** Append a text delta from the LLM stream. */
  appendDelta(delta: string): void {
    if (!delta) {
      return;
    }
    this.buffer += delta;
    this.fullText += delta;
    this.scheduleFlush();
  }

  /** Get all accumulated text so far. */
  getFullText(): string {
    return this.fullText;
  }

  /**
   * Flush buffered text immediately (ordered after in-flight pushes), stripping
   * any internal references before they reach the client.
   *
   * To keep a path that straddles two flush windows from being pushed half-open
   * (and thus slipping past the sanitizer), an unterminated code span — odd
   * number of backticks — is held back in the buffer until its closing backtick
   * arrives. `finish()` passes `final` to flush the tail unconditionally so a
   * never-closed backtick still drains.
   */
  async flush(opts?: { final?: boolean }): Promise<void> {
    this.cancelTimer();
    let chunk = this.buffer;
    if (!opts?.final && (chunk.match(/`/g)?.length ?? 0) % 2 === 1) {
      const lastTick = chunk.lastIndexOf("`");
      this.buffer = chunk.slice(lastTick);
      chunk = chunk.slice(0, lastTick);
    } else {
      this.buffer = "";
    }
    const safe = sanitizeInternalRefs(chunk);
    this.pending = this.pending.then(async () => {
      if (safe) {
        await this.pusher.pushText(this.topic, safe, this.historyId);
      }
    });
    await this.pending;
  }

  /** Signal that the stream is done: flush remaining buffer + push done event. */
  async finish(): Promise<void> {
    await this.flush({ final: true });
    await this.pusher.pushDone(this.topic, this.historyId);
  }

  /** Push an error after draining in-flight text pushes. */
  async pushError(error: string): Promise<void> {
    this.cancelTimer();
    this.buffer = "";
    await this.pending;
    await this.pusher.pushError(this.topic, error, this.historyId);
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
