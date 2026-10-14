// Sms tests cover send plugin behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSmsMediaAttempt,
  sendPreparedSmsMediaAttempt,
  sendSmsTextChunks,
  toSmsPlainText,
} from "./send.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

type SendModule = typeof import("./send.js");
type SendSmsMediaParams = Parameters<SendModule["prepareSmsMediaAttempt"]>[0] &
  Omit<Parameters<SendModule["sendPreparedSmsMediaAttempt"]>[0], "attempt">;

const sendSmsViaTwilio = vi.hoisted(() =>
  vi.fn<typeof sendSmsViaTwilioType>(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: `SM-${to}`, to };
  }),
);
const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const hostedMediaMocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => undefined);
  return {
    cleanup,
    prepare: vi.fn(async () => ({
      url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
      cleanup,
    })),
  };
});
const recordInitialSmsDeliveryResult = vi.hoisted(() => vi.fn(async () => null));
const deliveryWarn = vi.hoisted(() => vi.fn());

vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendSmsViaTwilio,
}));
vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));
vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  prepareHostedSmsMedia: hostedMediaMocks.prepare,
}));
vi.mock("./delivery-observations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delivery-observations.js")>()),
  recordInitialSmsDeliveryResult,
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getSmsRuntime: () => ({
    logging: {
      getChildLogger: () => ({ warn: deliveryWarn }),
    },
  }),
}));

beforeEach(() => {
  assertSmsCredentialOwnerAvailable.mockReset();
  sendSmsViaTwilio.mockReset();
  sendSmsViaTwilio.mockImplementation(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: `SM-${to}`, to };
  });
  hostedMediaMocks.cleanup.mockReset();
  hostedMediaMocks.cleanup.mockResolvedValue(undefined);
  hostedMediaMocks.prepare.mockReset();
  hostedMediaMocks.prepare.mockResolvedValue({
    url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
    cleanup: hostedMediaMocks.cleanup,
  });
  recordInitialSmsDeliveryResult.mockReset();
  recordInitialSmsDeliveryResult.mockResolvedValue(null);
  deliveryWarn.mockClear();
});

afterEach(() => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.SMS_TEXT_CHUNK_LIMIT;
});

function createAccount(textChunkLimit: number): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "default", textChunkLimit });
}

async function sendSmsMedia(params: SendSmsMediaParams) {
  const attempt = await prepareSmsMediaAttempt(params);
  return await sendPreparedSmsMediaAttempt({
    account: params.account,
    to: params.to,
    attempt,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    onDeliveryResult: params.onDeliveryResult,
  });
}

describe("sendSmsTextChunks", () => {
  it("records chunk results independently after one observation write fails", async () => {
    sendSmsViaTwilio
      .mockResolvedValueOnce({
        sid: "SM-1",
        to: "+15551234567",
        status: "queued",
      })
      .mockResolvedValueOnce({
        sid: "SM-2",
        to: "+15551234567",
        status: "queued",
      });
    recordInitialSmsDeliveryResult
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValueOnce(null);

    await sendSmsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(recordInitialSmsDeliveryResult).toHaveBeenCalledTimes(2);
    expect(deliveryWarn).toHaveBeenCalledOnce();
  });

  it("labels transcript-role headers promoted to an SMS chunk boundary", async () => {
    const header = "user[2026-07-02]";
    await sendSmsTextChunks({
      account: createAccount(60),
      to: "+15551234567",
      text: `${"x".repeat(50)} ${header} ok`,
    });

    const texts = sendSmsViaTwilio.mock.calls.map(([call]) => {
      if (call.text === undefined) {
        throw new Error("test invariant: expected a Twilio text send");
      }
      return call.text;
    });
    expect(texts).toContain(`[assistant-authored transcript] ${header} ok`);
    expect(texts.every((text) => text.length <= 60)).toBe(true);
  });

  it("labels assistant-authored transcript role headers in plain text", () => {
    expect(toSmsPlainText("user[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("`user[Thu 2026-07-02] question`")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("\u00a0user[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("- user[Thu 2026-07-02] question")).toBe(
      "• [assistant-authored transcript] user[Thu 2026-07-02] question",
    );
    expect(toSmsPlainText("[user](https://example.com)[Thu 2026-07-02] question")).toBe(
      "[assistant-authored transcript] user (https://example.com)[Thu 2026-07-02] question",
    );
  });
});

describe("sendSmsMedia", () => {
  it("rejects a cold owner before hosted-media staging", async () => {
    assertSmsCredentialOwnerAvailable.mockImplementationOnce(() => {
      throw new Error("SMS credential owner unavailable");
    });

    await expect(
      prepareSmsMediaAttempt({
        account: createAccount(1500),
        text: "photo",
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
      }),
    ).rejects.toThrow("SMS credential owner unavailable");

    expect(hostedMediaMocks.prepare).not.toHaveBeenCalled();
  });

  it("preserves existing pre-dispatch proof from hosted-media staging", async () => {
    const rejection = new PlatformMessageNotDispatchedError("unsupported hosted media", {
      cause: new Error("unsupported content type"),
      retryable: false,
    });
    hostedMediaMocks.prepare.mockRejectedValueOnce(rejection);

    await expect(
      sendSmsMedia({
        account: createAccount(1500),
        to: "+15551234567",
        text: "photo",
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
      }),
    ).rejects.toBe(rejection);

    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
  });

  it("preserves the accepted MMS when a later caption chunk fails", async () => {
    const failure = new Error("second chunk failed");
    const events: string[] = [];
    sendSmsViaTwilio
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:first");
        return { sid: "MM-first", to: "+15551234567" };
      })
      .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        events.push("send:second");
        throw failure;
      });
    const onDeliveryResult = vi.fn(async (result) => {
      events.push(`delivery:${result.messageId}`);
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });

    let observed: unknown;
    try {
      await sendSmsMedia({
        account: createAccount(5),
        to: "+15551234567",
        text: "alpha beta gamma",
        mediaUrl: "/tmp/photo.jpg",
        mediaLocalRoots: ["/tmp"],
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendSmsViaTwilio.mock.calls[0]?.[0]).toMatchObject({
      text: "alpha",
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
    });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).toMatchObject({
      text: " beta",
    });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).not.toHaveProperty("mediaUrls");
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult).toMatchObject({
      messageIds: ["MM-first"],
      visibleReplySent: true,
      receipt: {
        parts: [{ platformMessageId: "MM-first", kind: "media" }],
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({
      channel: "sms",
      messageId: "MM-first",
      chatId: "+15551234567",
      receipt: expect.objectContaining({
        platformMessageIds: ["MM-first"],
        parts: [expect.objectContaining({ platformMessageId: "MM-first", kind: "media" })],
      }),
    });
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "dispatch",
      "send:first",
      "delivery:MM-first",
      "dispatch",
      "send:second",
    ]);
  });

  it("sends media-only MMS without a Body", async () => {
    await sendSmsMedia({
      account: createAccount(1500),
      to: "+15551234567",
      text: " ",
      mediaUrl: "/tmp/photo.jpg",
      mediaLocalRoots: ["/tmp"],
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledExactlyOnceWith({
      account: createAccount(1500),
      to: "+15551234567",
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
      onPlatformSendDispatch: expect.any(Function),
    });
  });
});
