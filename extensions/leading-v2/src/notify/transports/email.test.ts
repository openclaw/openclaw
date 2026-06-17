import { afterEach, describe, expect, it, vi } from "vitest";

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../../client/db-client.js", () => ({ query: mockQuery }));

import type { MySqlConfig } from "../../client/types.js";
import type { SmtpConfig } from "../email-client.js";
import type { Notification } from "../notification.js";
import { EmailNotificationTransport } from "./email.js";

const smtp: SmtpConfig = { host: "127.0.0.1", port: 8025, from: "noreply@ibtai.com" };
const db = { host: "h", port: 3306, user: "u", password: "p", database: "superworker" } as MySqlConfig;
const note: Notification = {
  id: "crawl_refresh:U1",
  uid: "1749",
  category: "crawl_refresh",
  level: "success",
  title: "互动量刷新完成",
  body: "转10 评5 赞100",
  ts: 1_750_000_000_000,
};

const origFetch = globalThis.fetch;
afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = origFetch;
});

describe("EmailNotificationTransport", () => {
  it("looks up the subscriber email and posts to the email proxy", async () => {
    mockQuery.mockResolvedValue([{ email: "user@ex.com" }]);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, statusText: "OK" } as Response;
    }) as typeof fetch;

    const res = await new EmailNotificationTransport(smtp, db).deliver(note, {});

    expect(res.ok).toBe(true);
    const [, sql, params] = mockQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("feed_report_subscriber");
    expect(params[0]).toBe("1749");
    expect(calls[0].url).toBe("http://127.0.0.1:8025/api/send-email");
    expect(calls[0].body).toMatchObject({ to: "user@ex.com", subject: "互动量刷新完成" });
    expect(String(calls[0].body.text)).toContain("转10 评5 赞100");
  });

  it("skips (ok=false) when the user has no subscriber email", async () => {
    mockQuery.mockResolvedValue([]);
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return { ok: true } as Response;
    }) as typeof fetch;

    const res = await new EmailNotificationTransport(smtp, db).deliver(note, {});
    expect(res.ok).toBe(false);
    expect(fetched).toBe(false);
  });
});
