import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
  signSmsTestForm,
} from "./webhook.test-support.js";

function createRequest(account: ResolvedSmsAccount, index: number): IncomingMessage {
  const form = {
    AccountSid: account.accountSid,
    From: account.fromNumber,
    To: "+15551234567",
    MessageSid: `SM${index.toString(16).padStart(32, "0")}`,
    MessageStatus: "sent",
  };
  const { body, signature } = signSmsTestForm(form, account);
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": signature,
  };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "203.0.113.50" },
  });
  return req;
}

function createRoute(account: ResolvedSmsAccount, warn = vi.fn()) {
  const delivery = createSmsTestDeliveryRecorder();
  const handler = createSmsWebhookHandler({
    cfg: {},
    account,
    ingress: { enqueue: vi.fn() },
    delivery,
    log: { warn },
  });
  return {
    delivery,
    submit: async (index: number) => {
      const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
      await handler(createRequest(account, index), res as unknown as ServerResponse);
      return res;
    },
  };
}

describe("SMS delivery callback admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds writes per account route and reopens after the window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.fn();
    const { delivery, submit } = createRoute(createSmsTestAccount({ accountId: "default" }), warn);

    for (let i = 0; i < 3_000; i += 1) {
      const res = await submit(i);
      expect(res.statusCode).toBe(200);
    }

    const rejectedRes = await submit(3_000);

    expect(rejectedRes.statusCode).toBe(503);
    expect(rejectedRes.setHeader).not.toHaveBeenCalledWith(
      "x-openclaw-delivery-accepted",
      "durable",
    );
    expect(delivery.record).toHaveBeenCalledTimes(3_000);
    expect(warn).toHaveBeenCalledWith("SMS delivery callback rate limit exceeded");

    const otherRoute = createRoute(
      createSmsTestAccount({
        accountId: "support",
        accountSid: "AC-support",
        webhookPath: "/webhooks/sms/support",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
      }),
    );
    const otherRes = await otherRoute.submit(3_001);
    expect(otherRes.statusCode).toBe(200);
    expect(otherRoute.delivery.record).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 60_001);
    const reopenedRes = await submit(3_000);

    expect(reopenedRes.statusCode).toBe(200);
    expect(reopenedRes.setHeader).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(delivery.record).toHaveBeenCalledTimes(3_001);
  });
});
