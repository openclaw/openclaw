import type { MercurePusher } from "../mercure.js";
import type { Notification, NotificationTransport, NotifyAddressing } from "../notification.js";

/**
 * T1 — in-app delivery via a generic Mercure `notification` event on the user's
 * topic. The web frontend renders it (bubble/toast) through one new handler.
 * See plan-notifier-delivery.md §3.1 for the wire contract.
 */
export class MercureNotificationTransport implements NotificationTransport {
  readonly id = "mercure-notification";

  constructor(private readonly pusher: MercurePusher) {}

  async deliver(n: Notification, to: NotifyAddressing): Promise<{ ok: boolean; note?: string }> {
    const topic = to.mercureTopic;
    if (!topic) {
      return { ok: false, note: "no mercure topic for user" };
    }
    const ok = await this.pusher.sendNotification(topic, {
      id: n.id,
      category: n.category,
      level: n.level,
      title: n.title,
      body: n.body,
      ...(n.link ? { link: n.link } : {}),
      ts: n.ts,
    });
    return { ok };
  }
}
