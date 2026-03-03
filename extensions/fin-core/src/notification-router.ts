import type { NotifyResult } from "./types.js";

/** Payload delivered to notification channels. */
export type NotificationEvent = {
  id: string;
  type: string;
  title: string;
  detail: string;
  timestamp: number;
};

/** A notification delivery channel. */
export interface NotificationChannel {
  readonly id: string;
  readonly name: string;
  enabled: boolean;
  send(event: NotificationEvent): Promise<{ success: boolean; error?: string }>;
}

/** Webhook notification channel — POSTs JSON to one or more URLs. */
export class WebhookChannel implements NotificationChannel {
  readonly id = "webhook";
  readonly name = "Webhook";
  enabled = true;

  constructor(
    private urls: string[],
    private timeoutMs = 5000,
  ) {}

  async send(event: NotificationEvent): Promise<{ success: boolean; error?: string }> {
    const body = JSON.stringify({ event, timestamp: Date.now(), source: "fin-core" });
    const headers = { "Content-Type": "application/json" };

    const results = await Promise.allSettled(
      this.urls.map((url) => this.postWithRetry(url, body, headers)),
    );

    // Success if ANY url succeeded.
    const anyOk = results.some(
      (r) => r.status === "fulfilled" && r.value,
    );
    if (anyOk) return { success: true };

    // Collect first error for diagnostics.
    const firstFailed = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    const error = firstFailed
      ? String((firstFailed.reason as Error).message ?? firstFailed.reason)
      : "all webhook URLs failed";

    return { success: false, error };
  }

  private async postWithRetry(url: string, body: string, headers: Record<string, string>): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return true;
      } catch (err) {
        // Retry once on first failure; rethrow on second.
        if (attempt === 1) throw err;
      }
    }
    return false;
  }
}

/** Routes notifications to registered channels. */
export class NotificationRouter {
  private channels = new Map<string, NotificationChannel>();

  /** Register a notification delivery channel. */
  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.id, channel);
  }

  /** List all registered channels with their status. */
  listChannels(): Array<{ id: string; name: string; enabled: boolean }> {
    return [...this.channels.values()].map((ch) => ({
      id: ch.id,
      name: ch.name,
      enabled: ch.enabled,
    }));
  }

  /** Send a notification to channels. Optionally filter by channel IDs. */
  async notify(event: NotificationEvent, channelIds?: string[]): Promise<NotifyResult[]> {
    let targets = [...this.channels.values()];

    if (channelIds) {
      const idSet = new Set(channelIds);
      targets = targets.filter((ch) => idSet.has(ch.id));
    }

    // Skip disabled channels.
    targets = targets.filter((ch) => ch.enabled);

    if (targets.length === 0) return [];

    const settled = await Promise.allSettled(
      targets.map(async (ch): Promise<NotifyResult> => {
        const result = await ch.send(event);
        return {
          channel: ch.id,
          success: result.success,
          ...(result.error ? { error: result.error } : {}),
        };
      }),
    );

    return settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { channel: "unknown", success: false, error: String((s.reason as Error).message ?? s.reason) },
    );
  }
}
