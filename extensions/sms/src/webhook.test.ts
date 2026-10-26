import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import { createSmsWebhookHandler, type SmsWebhookHandlerParams } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestRequest,
  createSmsTestResponse as createResponse,
  createSmsTestDeliveryRecorder,
  createSmsTestForm,
  signSmsTestForm as signForm,
} from "./webhook.test-support.js";

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "accepted" as const, duplicate: false })),
);
vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));

function fixture(
  overrides: Omit<Partial<SmsWebhookHandlerParams>, "delivery"> & {
    delivery?: ReturnType<typeof createSmsTestDeliveryRecorder>;
  } = {},
) {
  const account = overrides.account ?? createSmsTestAccount();
  const delivery = overrides.delivery ?? createSmsTestDeliveryRecorder();
  const handler = createSmsWebhookHandler({
    cfg: {},
    ingress: { enqueue: enqueueSmsIngress },
    ...overrides,
    account,
    delivery,
  });
  async function post(
    form: Record<string, string>,
    status = 200,
    options?: Parameters<typeof createSmsTestRequest>[1],
    signature?: string,
  ) {
    const payload = signForm(form, account);
    const res = createResponse();
    await handler(
      createSmsTestRequest({ ...payload, signature: signature ?? payload.signature }, options),
      res,
    );
    expect(res.statusCode).toBe(status);
    return res;
  }
  return {
    account,
    delivery,
    handler,
    post,
    sms: (
      fields: Record<string, string> = {},
      status = 200,
      options?: Parameters<typeof createSmsTestRequest>[1],
    ) => post(createSmsTestForm(fields, account), status, options),
    statusForm: (fields: Record<string, string> = {}) => ({
      AccountSid: account.accountSid,
      From: account.fromNumber,
      To: "+15551234567",
      MessageSid: "SM-status",
      MessageStatus: "sent",
      ...fields,
    }),
  };
}

function streamRequest(read: () => void): IncomingMessage {
  const req = new Readable({ read }) as IncomingMessage;
  req.method = "POST";
  req.headers = {};
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  Object.defineProperty(req, "socket", { value: socket });
  return req;
}

function expectDurable(res: ReturnType<typeof createResponse>) {
  expect(res.statusCode).toBe(200);
  expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
}

const proxy = (address: string) => ({ headers: { "x-forwarded-for": address } });

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    enqueueSmsIngress.mockReset().mockResolvedValue({ kind: "accepted", duplicate: false });
    advanceSmsTestAccountId();
  });

  it("rechecks the owner after parsing and before authentication or durable admission", async () => {
    let bodyRead = false;
    assertSmsCredentialOwnerAvailable.mockImplementationOnce(() => {
      expect(bodyRead).toBe(true);
      throw new Error("SMS credential owner unavailable");
    });
    const f = fixture();
    const { body, signature } = signForm(createSmsTestForm(), f.account);
    const req = streamRequest(() => {});
    req.headers = {
      "content-length": String(Buffer.byteLength(body)),
      "x-twilio-signature": signature,
    };
    const pending = f.handler(req, createResponse());
    req.push(body);
    bodyRead = true;
    req.push(null);
    await expect(pending).rejects.toThrow("SMS credential owner unavailable");
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("validates a fragmentless signature before enqueuing the raw Twilio form", async () => {
    const f = fixture({
      account: createSmsTestAccount({
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
      }),
    });
    const form = createSmsTestForm();
    const signed = signForm(form); // Sign without the connection-override fragment.
    const res = createResponse();
    await f.handler(createSmsTestRequest(signed), res);
    expectDurable(res);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
  });

  it("rethrows unexpected request read failures for Gateway-owned retry responses", async () => {
    const req = streamRequest(function (this: Readable) {
      this.destroy(new Error("read failed"));
    });
    const res = createResponse();
    await expect(fixture().handler(req, res)).rejects.toThrow("read failed");
    expect(res.endMock).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("keeps legacy inbound SmsStatus=receiving on the durable ingress path", async () => {
    const f = fixture();
    const form = createSmsTestForm({ SmsSid: "SM-legacy", SmsStatus: "receiving" }, f.account);
    delete form.MessageSid;
    await f.post(form);
    expect(f.delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
  });

  it.each(["delivery", "ingress"] as const)(
    "waits for the durable %s commit before HTTP 200",
    async (kind) => {
      const commit = createDeferred<void>();
      const recorder = createSmsTestDeliveryRecorder();
      const delivery = createSmsTestDeliveryRecorder(
        vi.fn<SmsDeliveryRecorder["record"]>(async (params) => {
          await commit.promise;
          return recorder.record(params);
        }),
      );
      if (kind === "ingress") {
        enqueueSmsIngress.mockImplementationOnce(async () => {
          await commit.promise;
          return { kind: "accepted", duplicate: false };
        });
      }
      const f = fixture({ delivery });
      const form = kind === "delivery" ? f.statusForm() : createSmsTestForm();
      const res = createResponse();
      const pending = f.handler(createSmsTestRequest(signForm(form, f.account)), res);
      await vi.waitFor(() =>
        expect(kind === "delivery" ? delivery.record : enqueueSmsIngress).toHaveBeenCalledOnce(),
      );
      expect(res.endMock).not.toHaveBeenCalled();
      expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
      commit.resolve();
      await pending;
      expectDurable(res);
      expect(res.endMock).toHaveBeenCalledOnce();
      if (kind === "delivery") {
        expect(delivery.record).toHaveBeenCalledWith({ account: f.account, form });
        expect(enqueueSmsIngress).not.toHaveBeenCalled();
      }
    },
  );

  it("acknowledges but does not store a signed delivery callback for another account", async () => {
    const f = fixture();
    const res = await f.post(f.statusForm({ AccountSid: "AC-other", MessageStatus: "failed" }));
    expect(f.delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it.each(["delivery", "ingress"] as const)(
    "does not acknowledge failed durable %s",
    async (kind) => {
      const failure = new Error("sqlite unavailable");
      const delivery = createSmsTestDeliveryRecorder(
        vi.fn<SmsDeliveryRecorder["record"]>(async () => {
          throw failure;
        }),
      );
      if (kind === "ingress") {
        enqueueSmsIngress.mockRejectedValueOnce(failure);
      }
      const f = fixture({ delivery });
      const form = kind === "delivery" ? f.statusForm() : createSmsTestForm();
      const res = createResponse();
      await expect(f.handler(createSmsTestRequest(signForm(form, f.account)), res)).rejects.toBe(
        failure,
      );
      expect(res.endMock).not.toHaveBeenCalled();
      expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
      if (kind === "delivery") {
        expect(enqueueSmsIngress).not.toHaveBeenCalled();
      }
    },
  );

  it("still acks durable when the enqueue reports a replayed duplicate", async () => {
    enqueueSmsIngress.mockResolvedValueOnce({ kind: "accepted", duplicate: true });
    expectDurable(await fixture().sms());
  });

  it("rejects a signed webhook without a stable MessageSid", async () => {
    const form = createSmsTestForm();
    delete form.MessageSid;
    await fixture().post(form, 400);
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("accepts the legacy SmsMessageSid event id alias", async () => {
    const form = createSmsTestForm({ SmsMessageSid: "SM-alias" });
    delete form.MessageSid;
    await fixture().post(form);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
  });

  it("durably accepts a signed account mismatch for non-retryable drain classification", async () => {
    await fixture().sms({ AccountSid: "AC-other" });
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({ AccountSid: "AC-other" }),
    );
  });

  it("does not let unsigned proxy traffic consume the same client's signed webhook rate limit", async () => {
    const f = fixture({ cfg: { gateway: { trustedProxies: ["127.0.0.1"] } } });
    const form = f.statusForm();
    const options = proxy("203.0.113.10");
    for (let i = 0; i < 300; i++) {
      await f.post(form, 403, options, "invalid");
    }
    await f.post(form, 429, options, "invalid");
    expect(f.delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
    await f.sms({}, 200, options);
    expect(enqueueSmsIngress).toHaveBeenCalledOnce();
  });

  it("scopes signed webhook rate limits to one SMS account and route", async () => {
    const support = fixture({
      account: createSmsTestAccount({
        accountId: "support",
        accountSid: "AC-support",
        webhookPath: "/webhooks/sms/support",
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
      }),
    });
    for (let i = 0; i < 30; i++) {
      await support.sms({ MessageSid: "SM-" + i });
    }
    await support.sms({ MessageSid: "SM-over" }, 429);
    await fixture().sms();
  });

  it("meters inbound dispatch per sender without throttling signed delivery callbacks", async () => {
    const warn = vi.fn();
    const f = fixture({ log: { warn } });
    const options = { remoteAddress: "203.0.113.30" };
    for (let i = 0; i < 30; i++) {
      await f.sms({ MessageSid: "SM-" + i }, 200, options);
    }
    await f.sms({ MessageSid: "SM-over", From: "RCS:+1 (555) 123-4567" }, 429, options);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(30);
    expect(warn).toHaveBeenCalledWith("SMS webhook callback rate limit exceeded");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("+15551234567"));
    await f.sms({ MessageSid: "SM-other", From: "+15559998888" }, 200, options);
    await f.sms({ MessageSid: "SM-still-over" }, 429, { remoteAddress: "203.0.113.31" });
    await f.post(f.statusForm({ MessageStatus: "delivered" }));
    expect(f.delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it("bounds aggregate inbound fan-out without throttling signed delivery callbacks", async () => {
    const f = fixture();
    for (let i = 0; i < 300; i++) {
      await f.sms({ MessageSid: "SM-" + i, From: "+1555" + i.toString().padStart(7, "0") });
    }
    await f.sms({ MessageSid: "SM-over", From: "+15559999999" }, 429);
    await f.post(f.statusForm({ MessageStatus: "delivered" }));
    expect(f.delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(300);
  });

  it("shares one quota for invalid signed senders without throttling a valid sender", async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) {
      await f.sms({ MessageSid: "SM-" + i, From: "not-a-phone" });
    }
    await f.sms({ MessageSid: "SM-over", From: "still-not-a-phone" }, 429);
    await f.sms();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it.each(["ingress", "delivery"] as const)(
    "meters unsigned %s by client address",
    async (kind) => {
      const f = fixture({
        cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
        account: createSmsTestAccount({ dangerouslyDisableSignatureValidation: true }),
      });
      const form = (index: number) =>
        kind === "delivery"
          ? f.statusForm({ MessageSid: "SM-" + index })
          : createSmsTestForm(
              { MessageSid: "SM-" + index, From: "+1555000" + (1000 + index) },
              f.account,
            );
      for (let i = 0; i < 30; i++) {
        await f.post(form(i), 200, proxy("203.0.113.40"), "unused");
      }
      await f.post(form(30), 429, proxy("203.0.113.40"), "unused");
      const effect = kind === "delivery" ? f.delivery.record : enqueueSmsIngress;
      expect(effect).toHaveBeenCalledTimes(30);
      if (kind === "delivery") {
        await f.post(form(31), 200, proxy("203.0.113.41"), "unused");
        expect(effect).toHaveBeenCalledTimes(31);
      }
    },
  );
});
