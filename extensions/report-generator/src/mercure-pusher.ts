import type { PluginLogger } from "../api.js";
import type { ActivityStep } from "./tool-activity.js";
import type { MercureConfig } from "./types.js";

interface PushOptions {
  topic: string;
  title: string;
  content: string;
  userId?: string;
  /** Download/report task id; lets the frontend bind this event to its card. */
  taskId?: number;
  /**
   * Mercure topic to publish on. When set (chat-initiated tasks carry the
   * frontend's subscription topic, e.g. "lobster/user/<uid>") it is used
   * verbatim; otherwise falls back to the legacy `user/<topic>` target.
   */
  targetTopic?: string;
}

export class MercurePusher {
  private readonly config: MercureConfig;
  private readonly logger?: PluginLogger;

  constructor(config: MercureConfig, logger?: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Generate a publisher JWT token (HS256) from the configured secret.
   * Same scheme as the rabbitmq-consumer plugin's MercurePusher.
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
      encoder.encode(this.config.jwtSecret),
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
   * Push the finished report to Mercure hub (frontend "report" event).
   * Mercure hub URL is like http://localhost:3000/.well-known/mercure
   */
  async push(options: PushOptions): Promise<void> {
    const { topic, title, content, taskId, targetTopic } = options;

    const payload = {
      title,
      content,
      topic,
      type: "report",
      ...(taskId === undefined ? {} : { taskId }),
    };

    // The final report must land on the SAME topic the frontend subscribed
    // to for this chat (where report_created/report_text/report_done went);
    // publishing to the legacy `user/<uid>` while the frontend listens on
    // e.g. `lobster/user/<uid>` silently drops the finished report.
    await this.sendToMercure(targetTopic || `user/${topic}`, payload);
  }

  /**
   * Push a report-generation progress chunk. Typed `report_text` (not `text`)
   * so the frontend renders it into the report card keyed by taskId instead of
   * the chat bubble; chat `text` events stay untouched.
   */
  async pushReportText(topic: string, content: string, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_text", content, taskId });
  }

  /**
   * Push a sanitized generation-activity status line scoped to taskId
   * (e.g. "正在查询分析数据（第 2 步）…"). Typed `report_progress` so the
   * frontend shows it as a transient status on the report card instead of
   * appending it to the report body.
   */
  async pushReportProgress(topic: string, content: string, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_progress", content, taskId });
  }

  /**
   * Push a structured timeline step (start/end) scoped to taskId for the
   * frontend's collapsible "工作过程" panel on the report card. Typed
   * `report_step` so it lands on the card's step list, not the report body.
   * Carries only sanitized label/category — never tool args.
   */
  async pushReportStep(topic: string, step: ActivityStep, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_step", ...step, taskId });
  }

  /** Signal that the report progress stream for taskId is finished. */
  async pushReportDone(topic: string, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_done", taskId });
  }

  /** Push a report-generation error scoped to taskId. */
  async pushReportError(topic: string, error: string, taskId: number): Promise<boolean> {
    return this.sendToMercure(topic, { type: "report_error", error, taskId });
  }

  private async sendToMercure(topic: string, data: Record<string, unknown>): Promise<boolean> {
    try {
      const token = await this.generatePublisherJwt();

      const formData = new URLSearchParams({
        topic,
        data: JSON.stringify(data),
      });

      const response = await fetch(this.config.hubUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Mercure push failed: ${response.status} ${response.statusText}`);
      }
      return true;
    } catch (error) {
      // Log but don't throw - Mercure push failure shouldn't block report completion
      this.logger?.error(`[MERCURE_PUSHER] Push failed: ${String(error)}`);
      return false;
    }
  }
}

/**
 * Buffered streaming pusher: collects LLM text deltas and flushes them as
 * batched Mercure pushes, creating a typewriter effect during report
 * generation. Mirrors the rabbitmq-consumer plugin's StreamingMercurePusher.
 */
export class StreamingMercurePusher {
  private readonly pusher: MercurePusher;
  private readonly topic: string;
  private readonly taskId: number;
  private readonly flushIntervalMs: number;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fullText = "";
  /** Chains flushes so pushes always reach the hub in order. */
  private pending: Promise<void> = Promise.resolve();

  constructor(pusher: MercurePusher, topic: string, taskId: number, flushIntervalMs = 80) {
    this.pusher = pusher;
    this.topic = topic;
    this.taskId = taskId;
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

  /** Flush any buffered text immediately (ordered after in-flight pushes). */
  async flush(): Promise<void> {
    this.cancelTimer();
    const chunk = this.buffer;
    this.buffer = "";
    this.pending = this.pending.then(async () => {
      if (chunk) {
        await this.pusher.pushReportText(this.topic, chunk, this.taskId);
      }
    });
    await this.pending;
  }

  /** Signal that the stream is done: flush remaining buffer + push done event. */
  async finish(): Promise<void> {
    await this.flush();
    await this.pusher.pushReportDone(this.topic, this.taskId);
  }

  /** Push an error after draining in-flight text pushes. */
  async pushError(error: string): Promise<void> {
    this.cancelTimer();
    this.buffer = "";
    await this.pending;
    await this.pusher.pushReportError(this.topic, error, this.taskId);
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
