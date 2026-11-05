import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPartialSmsSend } from "./partial-send.test-support.js";
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

const TO = "+15551234567";

const sendSmsViaTwilio = vi.hoisted(() => vi.fn<typeof sendSmsViaTwilioType>());
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
  hostedMediaMocks.cleanup.mockReset().mockResolvedValue(undefined);
  hostedMediaMocks.prepare.mockReset().mockResolvedValue({
    url: "https://gateway.example.com/webhooks/sms/media/abc?token=token",
    cleanup: hostedMediaMocks.cleanup,
  });
  recordInitialSmsDeliveryResult.mockReset().mockResolvedValue(null);
  deliveryWarn.mockClear();
});

function createAccount(textChunkLimit: number): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "default", textChunkLimit });
}

async function sendSmsMedia(params: SendSmsMediaParams) {
  const attempt = await prepareSmsMediaAttempt(params);
  return await sendPreparedSmsMediaAttempt({ ...params, attempt });
}

function mediaParams(overrides: Partial<SendSmsMediaParams> = {}): SendSmsMediaParams {
  return {
    account: createAccount(1500),
    to: TO,
    text: "photo",
    mediaUrl: "/tmp/photo.jpg",
    mediaLocalRoots: ["/tmp"],
    ...overrides,
  };
}

describe("sendSmsTextChunks", () => {
  it("records chunk results independently after one observation write fails", async () => {
    sendSmsViaTwilio
      .mockResolvedValueOnce({ sid: "SM-1", to: TO, status: "queued" })
      .mockResolvedValueOnce({ sid: "SM-2", to: TO, status: "queued" });
    recordInitialSmsDeliveryResult
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValueOnce(null);

    await sendSmsTextChunks({ account: createAccount(5), to: TO, text: "alpha beta" });

    expect(sendSmsViaTwilio).toHaveBeenCalledTimes(2);
    expect(recordInitialSmsDeliveryResult).toHaveBeenCalledTimes(2);
    expect(deliveryWarn).toHaveBeenCalledOnce();
  });

  it("labels transcript-role headers promoted to an SMS chunk boundary", async () => {
    const header = "user[2026-07-02]";
    await sendSmsTextChunks({
      account: createAccount(60),
      to: TO,
      text: `${"x".repeat(50)} ${header} ok`,
    });

    const texts = sendSmsViaTwilio.mock.calls.map(([call]) => call.text);
    expect(texts).toContain(`[assistant-authored transcript] ${header} ok`);
    expect(texts.every((text) => text !== undefined && text.length <= 60)).toBe(true);
  });

  it("labels assistant-authored transcript role headers in plain text", () => {
    const header = "user[Thu 2026-07-02] question";
    const labeled = `[assistant-authored transcript] ${header}`;
    expect(toSmsPlainText(header)).toBe(labeled);
    expect(toSmsPlainText(`\`${header}\``)).toBe(labeled);
    expect(toSmsPlainText(`\u00a0${header}`)).toBe(labeled);
    expect(toSmsPlainText(`- ${header}`)).toBe(`• ${labeled}`);
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

    await expect(prepareSmsMediaAttempt(mediaParams())).rejects.toThrow(
      "SMS credential owner unavailable",
    );

    expect(hostedMediaMocks.prepare).not.toHaveBeenCalled();
  });

  it("preserves existing pre-dispatch proof from hosted-media staging", async () => {
    const rejection = new PlatformMessageNotDispatchedError("unsupported hosted media", {
      cause: new Error("unsupported content type"),
      retryable: false,
    });
    hostedMediaMocks.prepare.mockRejectedValueOnce(rejection);

    await expect(sendSmsMedia(mediaParams())).rejects.toBe(rejection);

    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
  });

  it("preserves the accepted MMS when a later caption chunk fails", async () => {
    const fixture = createPartialSmsSend(sendSmsViaTwilio, "MM-first", "media");
    const { onPlatformSendDispatch, onDeliveryResult } = fixture;

    const observed: unknown = await sendSmsMedia(
      mediaParams({
        account: createAccount(5),
        text: "alpha beta gamma",
        onPlatformSendDispatch,
        onDeliveryResult,
      }),
    ).catch((error: unknown) => error);

    expect(sendSmsViaTwilio.mock.calls[0]?.[0]).toMatchObject({
      text: "alpha",
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
    });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).toMatchObject({ text: " beta" });
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).not.toHaveProperty("mediaUrls");
    fixture.expectPartial(observed);
  });

  it("sends media-only MMS without a Body", async () => {
    await sendSmsMedia(mediaParams({ text: " " }));

    expect(sendSmsViaTwilio).toHaveBeenCalledExactlyOnceWith({
      account: createAccount(1500),
      to: TO,
      mediaUrls: ["https://gateway.example.com/webhooks/sms/media/abc?token=token"],
      onPlatformSendDispatch: expect.any(Function),
    });
  });
});
