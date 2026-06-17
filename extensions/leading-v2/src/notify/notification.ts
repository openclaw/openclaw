import type { PluginLogger } from "../../api.js";

/** A thing that happened and should be surfaced to a user. Transport-agnostic. */
export interface Notification {
  id: string; // dedupe/ack key
  uid: string;
  category: string; // source business: "crawl_refresh" | "report" | ...
  level: "info" | "success" | "warn" | "error";
  title: string;
  body: string; // plain text / markdown
  link?: string; // optional fileLink / detail url
  ts: number;
}

/** Where a notification can be delivered for a given user (captured at submit time). */
export interface NotifyAddressing {
  mercureTopic?: string;
  sessionKey?: string;
  email?: string;
}

/** A single delivery channel (Mercure in-app event, email, IM webhook, …). */
export interface NotificationTransport {
  readonly id: string;
  deliver(n: Notification, to: NotifyAddressing): Promise<{ ok: boolean; note?: string }>;
}

/**
 * Fans a Notification out to all configured transports. Decouples "what happened"
 * (completion notifier, scheduled tasks) from "how it's shown" (transports).
 * A failing transport never blocks the others.
 */
export class Notifier {
  constructor(
    private readonly transports: NotificationTransport[],
    private readonly logger?: PluginLogger,
  ) {}

  hasTransports(): boolean {
    return this.transports.length > 0;
  }

  /** Returns true if at least one transport accepted the notification. */
  async notify(n: Notification, to: NotifyAddressing): Promise<boolean> {
    let anyOk = false;
    for (const transport of this.transports) {
      try {
        const result = await transport.deliver(n, to);
        if (result.ok) {
          anyOk = true;
        } else {
          this.logger?.warn(`[LEADING_V2_NOTIFY] transport ${transport.id} skipped: ${result.note ?? "?"}`);
        }
      } catch (error) {
        this.logger?.error(`[LEADING_V2_NOTIFY] transport ${transport.id} failed: ${String(error)}`);
      }
    }
    return anyOk;
  }
}
