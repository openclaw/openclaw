import { afterEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockSendMail } = vi.hoisted(() => ({
  mockQuery: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockSendMail: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../../client/db-client.js", () => ({ query: mockQuery }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mockSendMail }) },
}));

import type { MySqlConfig } from "../../client/types.js";
import type { SmtpConfig } from "../email-client.js";
import type { Notification } from "../notification.js";
import { EmailNotificationTransport } from "./email.js";

const smtp: SmtpConfig = {
  host: "smtp.exmail.qq.com",
  port: 465,
  user: "zhoufeng@ibtai.com",
  password: "authcode",
};
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

afterEach(() => vi.clearAllMocks());

describe("EmailNotificationTransport", () => {
  it("looks up the subscriber email and sends via SMTP", async () => {
    mockQuery.mockResolvedValue([{ email: "user@ex.com" }]);
    mockSendMail.mockResolvedValue({ messageId: "1" });

    const res = await new EmailNotificationTransport(smtp, db).deliver(note, {});

    expect(res.ok).toBe(true);
    const [, sql, params] = mockQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("feed_report_subscriber");
    expect(params[0]).toBe("1749");
    const mail = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(mail).toMatchObject({
      from: "zhoufeng@ibtai.com",
      to: "user@ex.com",
      subject: "互动量刷新完成",
    });
    expect(String(mail.text)).toContain("转10 评5 赞100");
  });

  it("skips (ok=false) when the user has no subscriber email", async () => {
    mockQuery.mockResolvedValue([]);
    const res = await new EmailNotificationTransport(smtp, db).deliver(note, {});
    expect(res.ok).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
