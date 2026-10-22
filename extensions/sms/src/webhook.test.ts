import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsDeliveryRecorder } from "./delivery-observations.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler, type SmsWebhookHandlerParams } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
} from "./webhook.test-support.js";

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "accepted" as const, duplicate: false })),
);

vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));

function createHandler(overrides: Partial<SmsWebhookHandlerParams> = {}) {
  return createSmsWebhookHandler({
    cfg: {},
    account: createSmsTestAccount(),
    ingress: { enqueue: enqueueSmsIngress },
    ...overrides,
  });
}

function deliveryHarness(overrides: Partial<SmsWebhookHandlerParams> = {}) {
  const account = overrides.account ?? createSmsTestAccount();
  const delivery = createSmsTestDeliveryRecorder();
  return { account, delivery, handler: createHandler({ ...overrides, account, delivery }) };
}

function parseTestTwilioForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function createSignedBody(params?: {
  account?: ResolvedSmsAccount;
  body?: string;
  messageSid?: string;
}): { body: string; signature: string } {
  const account = params?.account ?? createSmsTestAccount();
  const body =
    params?.body ??
    `AccountSid=${encodeURIComponent(account.accountSid)}&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=${encodeURIComponent(params?.messageSid ?? "SM123")}`;
  const form = parseTestTwilioForm(body);
  const signed =
    account.publicWebhookUrl +
    Object.keys(form)
      .toSorted()
      .map((key) => `${key}${form[key] ?? ""}`)
      .join("");
  return {
    body,
    signature: createHmac("sha1", account.authToken).update(signed).digest("base64"),
  };
}

function signForm(form: Record<string, string>, account = createSmsTestAccount()) {
  return createSignedBody({ account, body: new URLSearchParams(form).toString() });
}

function createLoopbackSocket(remoteAddress = "127.0.0.1"): Socket {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
  return socket;
}

function createRequest(
  body: string,
  signature: string,
  options?: { headers?: Record<string, string>; remoteAddress?: string },
): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.method = "POST";
  req.headers = {
    "content-length": String(Buffer.byteLength(body)),
    "x-twilio-signature": signature,
    ...options?.headers,
  };
  Object.defineProperty(req, "socket", {
    value: createLoopbackSocket(options?.remoteAddress),
  });
  return req;
}

function configureRequest(req: IncomingMessage): IncomingMessage {
  req.method = "POST";
  req.headers = {};
  // A real socket: the reader hands a limited request to the connection-level
  // rejection owner, which subscribes to socket events before the caller answers.
  Object.defineProperty(req, "socket", { value: createLoopbackSocket() });
  return req;
}

function createFailingRequest(error?: Error): IncomingMessage {
  return configureRequest(
    new Readable({
      read() {
        this.destroy(error);
      },
    }) as IncomingMessage,
  );
}

function createPendingRequest(): IncomingMessage {
  return configureRequest(new Readable({ read() {} }) as IncomingMessage);
}

type TestResponse = ServerResponse & {
  setHeaderMock: ReturnType<typeof vi.fn>;
  endMock: ReturnType<typeof vi.fn>;
};

function createResponse(): TestResponse {
  const setHeaderMock = vi.fn();
  const endMock = vi.fn();
  return {
    statusCode: 200,
    setHeader: setHeaderMock,
    setHeaderMock,
    end: endMock,
    endMock,
  } as unknown as TestResponse;
}

async function dispatch(
  handler: ReturnType<typeof createHandler>,
  payload: { body: string; signature: string },
  options?: Parameters<typeof createRequest>[2],
) {
  const res = createResponse();
  await handler(createRequest(payload.body, payload.signature, options), res);
  return res;
}

async function expectStatus(
  handler: ReturnType<typeof createHandler>,
  payload: { body: string; signature: string },
  statusCode = 200,
  options?: Parameters<typeof createRequest>[2],
) {
  const res = await dispatch(handler, payload, options);
  expect(res.statusCode).toBe(statusCode);
  return res;
}

function expectDurable(res: TestResponse) {
  expect(res.statusCode).toBe(200);
  expect(res.setHeaderMock).toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
}

function proxyPost(
  handler: ReturnType<typeof createHandler>,
  body: string,
  status: number,
  address: string,
  signature = "unused-signature",
) {
  return expectStatus(handler, { body, signature }, status, {
    headers: { "x-forwarded-for": address },
  });
}

function createSignedSmsPayload(
  messageSid: string,
  overrides: { from?: string; to?: string } = {},
): { body: string; signature: string } {
  return signForm({
    AccountSid: "AC123",
    From: overrides.from ?? "+15551234567",
    To: overrides.to ?? "+15557654321",
    Body: "hello",
    MessageSid: messageSid,
  });
}

function createSignedDeliveryPayload(
  messageSid: string,
  status: string,
  params: { account?: ResolvedSmsAccount; accountSid?: string } = {},
) {
  const account = params.account ?? createSmsTestAccount();
  const form = {
    AccountSid: params.accountSid ?? account.accountSid,
    From: account.fromNumber,
    To: "+15551234567",
    MessageSid: messageSid,
    MessageStatus: status,
  };
  return { ...signForm(form, account), form };
}

function createMessageSid(index: number): string {
  return `SM${index.toString(16).padStart(32, "0")}`;
}

describe("createSmsWebhookHandler", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    advanceSmsTestAccountId();
  });

  it("rechecks the owner after parsing and before authentication or durable admission", async () => {
    let bodyRead = false;
    assertSmsCredentialOwnerAvailable.mockImplementationOnce(() => {
      expect(bodyRead).toBe(true);
      throw new Error("SMS credential owner unavailable");
    });
    const { body, signature } = createSignedBody();
    const handler = createHandler();
    const res = createResponse();
    const req = createPendingRequest();
    req.headers = {
      "content-length": String(Buffer.byteLength(body)),
      "x-twilio-signature": signature,
    };

    const pending = handler(req, res);
    req.push(body);
    bodyRead = true;
    req.push(null);

    await expect(pending).rejects.toThrow("SMS credential owner unavailable");
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("validates a fragmentless signature before enqueuing the raw Twilio form", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(1));
    const handler = createHandler({
      account: createSmsTestAccount({
        publicWebhookUrl: "https://gateway.example.com/webhooks/sms#rp=4xx",
      }),
    });

    const res = await dispatch(handler, { body, signature });

    expectDurable(res);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(parseTestTwilioForm(body));
  });

  it("rethrows unexpected request read failures for Gateway-owned retry responses", async () => {
    const handler = createHandler();
    const res = createResponse();

    await expect(handler(createFailingRequest(new Error("read failed")), res)).rejects.toThrow(
      "read failed",
    );
    expect(res.endMock).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("keeps legacy inbound SmsStatus=receiving on the durable ingress path", async () => {
    const { account, delivery, handler } = deliveryHarness();
    const form = {
      AccountSid: account.accountSid,
      From: "+15551234567",
      To: account.fromNumber,
      Body: "hello",
      SmsSid: createMessageSid(24),
      SmsStatus: "receiving",
    };
    await expectStatus(handler, signForm(form, account));
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
  });

  it("does not acknowledge a delivery callback until durable persistence succeeds", async () => {
    const payload = createSignedDeliveryPayload(createMessageSid(21), "sent");
    const delivery = createSmsTestDeliveryRecorder(
      vi.fn<SmsDeliveryRecorder["record"]>(async () => {
        throw new Error("sqlite unavailable");
      }),
    );
    const handler = createHandler({ delivery });
    const res = createResponse();

    await expect(handler(createRequest(payload.body, payload.signature), res)).rejects.toThrow(
      "sqlite unavailable",
    );
    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("waits for the durable delivery commit before returning HTTP 200", async () => {
    const account = createSmsTestAccount();
    const payload = createSignedDeliveryPayload(createMessageSid(22), "sent", { account });
    const commit = createDeferred<void>();
    const recorder = createSmsTestDeliveryRecorder();
    const delivery = createSmsTestDeliveryRecorder(
      vi.fn<SmsDeliveryRecorder["record"]>(async (params) => {
        await commit.promise;
        return recorder.record(params);
      }),
    );
    const handler = createHandler({ account, delivery });
    const res = createResponse();

    const pending = handler(createRequest(payload.body, payload.signature), res);
    await vi.waitFor(() => expect(delivery.record).toHaveBeenCalledOnce());
    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");

    commit.resolve();
    await pending;

    expectDurable(res);
    expect(res.endMock).toHaveBeenCalledOnce();
    expect(delivery.record).toHaveBeenCalledWith({ account, form: payload.form });
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("acknowledges but does not store a signed delivery callback for another account", async () => {
    const payload = createSignedDeliveryPayload(createMessageSid(22), "failed", {
      accountSid: "AC-other",
    });
    const { delivery, handler } = deliveryHarness();
    const res = await expectStatus(handler, payload, 200);
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it("does not acknowledge when the durable enqueue fails", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(2));
    enqueueSmsIngress.mockRejectedValueOnce(new Error("sqlite unavailable"));
    const handler = createHandler();
    const res = createResponse();

    await expect(handler(createRequest(body, signature), res)).rejects.toThrow(
      "sqlite unavailable",
    );

    expect(res.endMock).not.toHaveBeenCalled();
    expect(res.setHeaderMock).not.toHaveBeenCalledWith("x-openclaw-delivery-accepted", "durable");
  });

  it("acknowledges only after the durable enqueue resolves", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(3));
    const admission = createDeferred<{ kind: "accepted"; duplicate: boolean }>();
    enqueueSmsIngress.mockImplementationOnce(() => admission.promise);
    const handler = createHandler();
    const res = createResponse();

    const handling = handler(createRequest(body, signature), res);
    await vi.waitFor(() => expect(enqueueSmsIngress).toHaveBeenCalledTimes(1));
    expect(res.endMock).not.toHaveBeenCalled();
    admission.resolve({ kind: "accepted", duplicate: false });
    await handling;

    expectDurable(res);
    expect(res.endMock).toHaveBeenCalledTimes(1);
  });

  it("still acks durable when the enqueue reports a replayed duplicate", async () => {
    const { body, signature } = createSignedSmsPayload(createMessageSid(4));
    enqueueSmsIngress.mockResolvedValueOnce({ kind: "accepted", duplicate: true });
    const handler = createHandler();
    const res = await expectStatus(handler, { body, signature });

    expectDurable(res);
  });

  it("rejects a signed webhook without a stable MessageSid", async () => {
    const body = "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello";
    const payload = createSignedBody({ body });
    const handler = createHandler();
    await expectStatus(handler, payload, 400);
    expect(enqueueSmsIngress).not.toHaveBeenCalled();
  });

  it("accepts the legacy SmsMessageSid event id alias", async () => {
    const body =
      "AccountSid=AC123&From=%2B15551234567&To=%2B15557654321&Body=hello&SmsMessageSid=SM-alias";
    const payload = createSignedBody({ body });
    const handler = createHandler();
    await expectStatus(handler, payload, 200);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({ SmsMessageSid: "SM-alias" }),
    );
  });

  it("durably accepts a signed account mismatch for non-retryable drain classification", async () => {
    const body = `AccountSid=AC-other&From=%2B15551234567&To=%2B15557654321&Body=hello&MessageSid=${createMessageSid(8)}`;
    const payload = createSignedBody({ body });
    const handler = createHandler();

    await expectStatus(handler, payload, 200);
    expect(enqueueSmsIngress).toHaveBeenCalledWith(
      expect.objectContaining({ AccountSid: "AC-other" }),
    );
  });

  it("does not let unsigned proxy traffic consume the same client's signed webhook rate limit", async () => {
    const { account, delivery, handler } = deliveryHarness({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
    });
    const unsignedBody =
      "AccountSid=AC123&From=%2B15550000000&To=%2B15557654321&MessageStatus=delivered&MessageSid=SM-bad";
    for (let i = 0; i < 300; i += 1) {
      await proxyPost(handler, unsignedBody, 403, "203.0.113.10", "not-a-valid-signature");
    }
    await proxyPost(handler, unsignedBody, 429, "203.0.113.10", "not-a-valid-signature");
    expect(delivery.record).not.toHaveBeenCalled();
    expect(enqueueSmsIngress).not.toHaveBeenCalled();

    const valid = createSignedBody({ account, messageSid: "SM-valid-after-invalid-burst" });
    await expectStatus(handler, valid, 200, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(1);
  });

  it("scopes signed webhook rate limits to one SMS account and route", async () => {
    const supportAccount = createSmsTestAccount({
      accountId: "support",
      accountSid: "AC-support",
      webhookPath: "/webhooks/sms/support",
      publicWebhookUrl: "https://gateway.example.com/webhooks/sms/support",
    });
    const defaultAccount = createSmsTestAccount();
    const supportHandler = createHandler({ account: supportAccount });
    const defaultHandler = createHandler({ account: defaultAccount });

    for (let i = 0; i < 30; i += 1) {
      const valid = createSignedBody({
        account: supportAccount,
        messageSid: `SM-support-${i}`,
      });
      await expectStatus(supportHandler, valid, 200);
    }
    const rateLimited = createSignedBody({
      account: supportAccount,
      messageSid: "SM-support-rate-limited",
    });
    await expectStatus(supportHandler, rateLimited, 429);

    const defaultValid = createSignedBody({
      account: defaultAccount,
      messageSid: "SM-default-after-support-limit",
    });
    await expectStatus(defaultHandler, defaultValid, 200);
  });

  it("meters inbound dispatch per sender without throttling signed delivery callbacks", async () => {
    const warn = vi.fn();
    const { account, delivery, handler } = deliveryHarness({ log: { warn } });

    for (let i = 0; i < 30; i += 1) {
      const { body, signature } = createSignedSmsPayload(createMessageSid(500 + i));
      await expectStatus(handler, { body, signature }, 200, {
        remoteAddress: "203.0.113.30",
      });
    }
    // Equivalent Twilio RCS address syntax canonicalizes into the same sender bucket.
    const overQuota = createSignedSmsPayload(createMessageSid(530), {
      from: "RCS:+1 (555) 123-4567",
    });
    await expectStatus(handler, overQuota, 429, { remoteAddress: "203.0.113.30" });
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(30);
    expect(warn).toHaveBeenCalledWith("SMS webhook callback rate limit exceeded");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("+15551234567"));

    // Same Twilio egress address, different validated sender: must still dispatch.
    const otherSender = createSignedSmsPayload(createMessageSid(531), { from: "+15559998888" });
    await expectStatus(handler, otherSender, 200, { remoteAddress: "203.0.113.30" });
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);

    // Changing Twilio egress addresses cannot widen the sender-scoped budget.
    const stillLimited = createSignedSmsPayload(createMessageSid(532));
    await expectStatus(handler, stillLimited, 429, { remoteAddress: "203.0.113.31" });
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);

    const status = createSignedDeliveryPayload(createMessageSid(533), "delivered", { account });
    await expectStatus(handler, status, 200);
    expect(delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it("bounds aggregate inbound fan-out without throttling signed delivery callbacks", async () => {
    const { account, delivery, handler } = deliveryHarness();

    for (let i = 0; i < 300; i += 1) {
      const distinctSender = `+1555${i.toString().padStart(7, "0")}`;
      const { body, signature } = createSignedSmsPayload(createMessageSid(900 + i), {
        from: distinctSender,
      });
      await expectStatus(handler, { body, signature }, 200);
    }

    const overAggregate = createSignedSmsPayload(createMessageSid(1_200), {
      from: "+15559999999",
    });
    await expectStatus(handler, overAggregate, 429);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(300);

    const status = createSignedDeliveryPayload(createMessageSid(1_201), "delivered", { account });
    await expectStatus(handler, status, 200);
    expect(delivery.record).toHaveBeenCalledOnce();
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(300);
  });

  it("shares one quota for invalid signed senders without throttling a valid sender", async () => {
    const handler = createHandler();

    for (let i = 0; i < 30; i += 1) {
      const invalidSender = createSignedSmsPayload(createMessageSid(800 + i), {
        from: "not-a-phone",
      });
      await expectStatus(handler, invalidSender, 200);
    }

    const invalidOverQuota = createSignedSmsPayload(createMessageSid(830), {
      from: "still-not-a-phone",
    });
    await expectStatus(handler, invalidOverQuota, 429);

    const validSender = createSignedSmsPayload(createMessageSid(831));
    await expectStatus(handler, validSender, 200);
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(31);
  });

  it("keeps validation-disabled webhook dispatches on the stricter callback budget", async () => {
    const account = createSmsTestAccount({ dangerouslyDisableSignatureValidation: true });
    const handler = createHandler({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
    });

    for (let i = 0; i < 30; i += 1) {
      // Rotate From: without signature validation it is unauthenticated input and
      // must not widen the address-keyed budget.
      const { body } = createSignedSmsPayload(createMessageSid(700 + i), {
        from: `+1555000${1000 + i}`,
      });
      await proxyPost(handler, body, 200, "203.0.113.20");
    }

    const overBudget = createSignedSmsPayload(createMessageSid(760), { from: "+15550009999" });
    await proxyPost(handler, overBudget.body, 429, "203.0.113.20");
    expect(enqueueSmsIngress).toHaveBeenCalledTimes(30);
  });

  it("rate limits unsigned delivery callbacks by client address before persistence", async () => {
    const account = createSmsTestAccount({ dangerouslyDisableSignatureValidation: true });
    const { delivery, handler } = deliveryHarness({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      account,
    });

    for (let i = 0; i < 30; i += 1) {
      const payload = createSignedDeliveryPayload(createMessageSid(1_300 + i), "sent", { account });
      await proxyPost(handler, payload.body, 200, "203.0.113.40");
    }

    const overBudget = createSignedDeliveryPayload(createMessageSid(1_330), "delivered", {
      account,
    });
    await proxyPost(handler, overBudget.body, 429, "203.0.113.40");
    expect(delivery.record).toHaveBeenCalledTimes(30);

    const otherAddress = createSignedDeliveryPayload(createMessageSid(1_331), "delivered", {
      account,
    });
    await proxyPost(handler, otherAddress.body, 200, "203.0.113.41");
    expect(delivery.record).toHaveBeenCalledTimes(31);
  });
});
