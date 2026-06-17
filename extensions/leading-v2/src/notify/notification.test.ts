import { describe, expect, it, vi } from "vitest";
import type { MercurePusher } from "./mercure.js";
import { Notifier, type Notification, type NotificationTransport } from "./notification.js";
import { MercureNotificationTransport } from "./transports/mercure-notification.js";

const note: Notification = {
  id: "crawl_refresh:U1",
  uid: "1749",
  category: "crawl_refresh",
  level: "success",
  title: "互动量刷新完成",
  body: "转10 评5 赞100",
  ts: 1_750_000_000_000,
};

function transport(id: string, result: { ok: boolean; note?: string }): NotificationTransport {
  return { id, deliver: vi.fn().mockResolvedValue(result) };
}

describe("Notifier", () => {
  it("fans out and returns true if any transport accepts", async () => {
    const t1 = transport("a", { ok: false, note: "skip" });
    const t2 = transport("b", { ok: true });
    const n = new Notifier([t1, t2]);
    expect(await n.notify(note, { mercureTopic: "1749" })).toBe(true);
    expect(t1.deliver).toHaveBeenCalledOnce();
    expect(t2.deliver).toHaveBeenCalledOnce();
  });

  it("returns false when every transport skips", async () => {
    const n = new Notifier([transport("a", { ok: false })]);
    expect(await n.notify(note, {})).toBe(false);
  });

  it("a throwing transport does not block the others", async () => {
    const boom: NotificationTransport = { id: "boom", deliver: vi.fn().mockRejectedValue(new Error("x")) };
    const ok = transport("ok", { ok: true });
    const n = new Notifier([boom, ok]);
    expect(await n.notify(note, {})).toBe(true);
    expect(ok.deliver).toHaveBeenCalledOnce();
  });

  it("hasTransports reflects the list", () => {
    expect(new Notifier([]).hasTransports()).toBe(false);
    expect(new Notifier([transport("a", { ok: true })]).hasTransports()).toBe(true);
  });
});

describe("MercureNotificationTransport", () => {
  it("publishes a notification with mapped fields when a topic is present", async () => {
    const sendNotification = vi.fn().mockResolvedValue(true);
    const pusher = { sendNotification } as unknown as MercurePusher;
    const t = new MercureNotificationTransport(pusher);

    const res = await t.deliver({ ...note, link: "https://oss/x" }, { mercureTopic: "lobster/user/1749" });

    expect(res.ok).toBe(true);
    const [topic, data] = sendNotification.mock.calls[0];
    expect(topic).toBe("lobster/user/1749");
    expect(data).toMatchObject({
      id: "crawl_refresh:U1",
      category: "crawl_refresh",
      level: "success",
      title: "互动量刷新完成",
      body: "转10 评5 赞100",
      link: "https://oss/x",
    });
  });

  it("skips (ok=false) when no topic is available", async () => {
    const pusher = { sendNotification: vi.fn() } as unknown as MercurePusher;
    const res = await new MercureNotificationTransport(pusher).deliver(note, {});
    expect(res.ok).toBe(false);
    expect(pusher.sendNotification).not.toHaveBeenCalled();
  });
});
