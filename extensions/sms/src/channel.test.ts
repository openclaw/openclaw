import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSmsAccount } from "./accounts.js";
import { smsPlugin } from "./channel.js";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import { createPartialSmsSend } from "./partial-send.test-support.js";
import type { probeSmsAccount as probeSmsAccountType } from "./status.js";
import type { sendSmsViaTwilio as sendSmsViaTwilioType } from "./twilio.js";
import type { SmsChannelConfig } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

const TO = "+15551234567";
const FROM = "+15557654321";

const sendSmsViaTwilio = vi.hoisted(() => vi.fn<typeof sendSmsViaTwilioType>());
const hostedMediaMocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => undefined);
  const url = "https://gateway.example.com/webhooks/sms/media/abc?token=token";
  return {
    cleanup,
    url,
    prepare: vi.fn(async () => ({ url, cleanup })),
  };
});
const listRecentSmsDeliveryRecords = vi.hoisted(() =>
  vi.fn(async (): Promise<SmsDeliveryRecord[]> => []),
);
const recordInitialSmsDeliveryResult = vi.hoisted(() => vi.fn(async () => null));
const probeSmsAccount = vi.hoisted(() =>
  vi.fn<typeof probeSmsAccountType>(async () => ({
    ok: true,
    webhook: { status: "skipped" as const, reason: "test" },
    hints: [],
  })),
);

vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendSmsViaTwilio,
}));
vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  prepareHostedSmsMedia: hostedMediaMocks.prepare,
}));
vi.mock("./delivery-observations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delivery-observations.js")>()),
  listRecentSmsDeliveryRecords,
  recordInitialSmsDeliveryResult,
}));
vi.mock("./status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.js")>()),
  probeSmsAccount,
}));

beforeEach(() => {
  sendSmsViaTwilio.mockReset();
  sendSmsViaTwilio.mockImplementation(async ({ to, onPlatformSendDispatch }) => {
    await onPlatformSendDispatch?.();
    return { sid: "SM-default", to, from: FROM, status: "queued" };
  });
  hostedMediaMocks.cleanup.mockReset().mockResolvedValue(undefined);
  hostedMediaMocks.prepare.mockReset().mockResolvedValue({
    url: hostedMediaMocks.url,
    cleanup: hostedMediaMocks.cleanup,
  });
  listRecentSmsDeliveryRecords.mockClear();
  recordInitialSmsDeliveryResult.mockReset().mockResolvedValue(null);
  probeSmsAccount.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function createConfig(overrides: SmsChannelConfig = {}) {
  return {
    channels: {
      sms: { accountSid: "AC123", authToken: "secret", fromNumber: FROM, ...overrides },
    },
  };
}

function mediaContext({
  config,
  ...overrides
}: {
  config?: SmsChannelConfig;
  text?: string;
  mediaLocalRoots?: string[];
  mediaReadFile?: () => Promise<Buffer>;
  onPlatformSendDispatch?: () => Promise<void>;
} = {}) {
  return {
    cfg: createConfig({ publicWebhookUrl: "https://gateway.example.com/webhooks/sms", ...config }),
    to: TO,
    text: "caption",
    kind: "media" as const,
    mediaUrl: "/tmp/photo.jpg",
    ...overrides,
  };
}

describe("smsPlugin setup", () => {
  it.each([
    ["default", "AC-updated", "AC-support", [TO], [FROM]],
    ["support", "AC123", "AC-updated", [FROM], [TO]],
  ] as const)(
    "patches only the %s account and preserves omitted fields",
    (accountId, rootSid, supportSid, rootAllowFrom, supportAllowFrom) => {
      const cfg = {
        commands: { text: false },
        ...createConfig({
          webhookPath: "/existing",
          allowFrom: [FROM],
          accounts: {
            support: { accountSid: "AC-support", authToken: "support-token", allowFrom: [FROM] },
            sibling: { accountSid: "AC-sibling", fromNumber: TO },
          },
        }),
      };
      const updated = smsPlugin.setupContract?.applyAccountConfig({
        cfg,
        accountId,
        input: { accountSid: "AC-updated", allowFrom: [TO] },
      });

      expect(updated?.commands).toEqual({ text: false });
      expect(updated?.channels?.sms).toEqual({
        accountSid: rootSid,
        authToken: "secret",
        fromNumber: FROM,
        webhookPath: "/existing",
        allowFrom: rootAllowFrom,
        accounts: {
          support: {
            accountSid: supportSid,
            authToken: "support-token",
            allowFrom: supportAllowFrom,
          },
          sibling: { accountSid: "AC-sibling", fromNumber: TO },
        },
      });
    },
  );
});

describe("smsPlugin status", () => {
  it("projects lifecycle from the runtime status record", async () => {
    const snapshot = await smsPlugin.status?.buildAccountSnapshot?.({
      cfg: {},
      account: createSmsTestAccount({ accountId: "support" }),
      runtime: { accountId: "support", lifecycle: "blocked", terminalDisconnect: true },
    });

    expect(snapshot).toMatchObject({ lifecycle: "blocked", terminalDisconnect: true });
  });

  it("passes only the remaining probe budget after loading delivery observations", async () => {
    vi.useFakeTimers();
    const account = createSmsTestAccount({
      accountId: "support",
      accountSid: "AC-support",
    });
    listRecentSmsDeliveryRecords.mockImplementationOnce(
      async () =>
        await new Promise<SmsDeliveryRecord[]>((resolve) => {
          setTimeout(() => resolve([]), 250);
        }),
    );

    const probe = smsPlugin.status?.probeAccount?.({
      cfg: {},
      account,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(250);
    await probe;

    expect(probeSmsAccount).toHaveBeenCalledWith({
      account,
      timeoutMs: 750,
      options: { deliveryRecords: [] },
    });
  });
});

describe("smsPlugin outbound", () => {
  it("declares an active text chunker and account-aware chunk limit", () => {
    expect(smsPlugin.configSchema).toBeDefined();
    expect(smsPlugin.status?.probeAccount).toBeDefined();
    expect(smsPlugin.status?.formatCapabilitiesProbe).toBeDefined();
    expect(smsPlugin.secrets?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.sms.accounts.*.authToken",
      "channels.sms.authToken",
    ]);
    expect(smsPlugin.messaging?.targetPrefixes).toEqual(["twilio-sms"]);
    expect(smsPlugin.outbound?.chunker?.("alpha beta", 6)).toEqual(["alpha", "beta"]);
    expect(
      smsPlugin.outbound?.resolveEffectiveTextChunkLimit?.({
        cfg: createConfig({ textChunkLimit: 42 }),
      }),
    ).toBe(42);
    expect(
      smsPlugin.outbound?.resolveEffectiveTextChunkLimit?.({
        cfg: createConfig({
          defaultAccount: "support",
          accounts: {
            support: {
              accountSid: "AC-support",
              authToken: "support-token",
              fromNumber: "+15551112222",
              textChunkLimit: 700,
            },
          },
        }),
      }),
    ).toBe(700);
  });

  it("uses defaultTo for targetless sends and preserves Twilio receipt metadata", async () => {
    const result = await smsPlugin.outbound?.sendText?.({
      cfg: createConfig({ defaultTo: TO }),
      to: "",
      text: "hello",
    });

    expect(sendSmsViaTwilio).toHaveBeenCalledWith(
      expect.objectContaining({ to: TO, text: "hello" }),
    );
    expect(result?.messageId).toBe("SM-default");
    expect(result?.receipt?.raw?.[0]).toMatchObject({
      messageId: "SM-default",
      chatId: TO,
      toJid: TO,
      meta: { from: FROM, status: "queued" },
    });
  });

  it("resolves the configured default SMS target for outbound delivery", () => {
    expect(
      smsPlugin.outbound?.resolveTarget?.({
        cfg: createConfig({ defaultTo: TO }),
        to: "",
      }),
    ).toEqual({ ok: true, to: TO });
  });

  it("hosts and sends outbound media as MMS with an ordered multipart receipt", async () => {
    for (const sid of ["MM-first", "SM-second"]) {
      sendSmsViaTwilio.mockResolvedValueOnce({
        sid,
        to: TO,
        from: FROM,
        status: "queued",
      });
    }
    const ctx = mediaContext({
      config: { textChunkLimit: 5 },
      text: "alpha beta",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: async () => Buffer.from("photo"),
    });
    await smsPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
    const result = await smsPlugin.message?.send?.media?.(ctx);

    expect(hostedMediaMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "/tmp/photo.jpg", mediaLocalRoots: ["/tmp"] }),
    );
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: TO,
        text: "alpha",
        mediaUrls: [hostedMediaMocks.url],
      }),
    );
    expect(sendSmsViaTwilio).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ to: TO, text: " beta" }),
    );
    expect(sendSmsViaTwilio.mock.calls[1]?.[0]).not.toHaveProperty("mediaUrls");
    expect(result?.messageId).toBe("MM-first");
    expect(result?.receipt.platformMessageIds).toEqual(["MM-first", "SM-second"]);
    expect(result?.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
    expect(recordInitialSmsDeliveryResult).toHaveBeenCalledTimes(2);
    for (const [index, sid] of ["MM-first", "SM-second"].entries()) {
      expect(recordInitialSmsDeliveryResult).toHaveBeenNthCalledWith(index + 1, {
        account: resolveSmsAccount(ctx.cfg),
        result: { sid, to: ctx.to, from: FROM, status: "queued" },
      });
    }
  });

  it("hosts durable MMS media in the lifecycle before platform send starts", async () => {
    const events: string[] = [];
    hostedMediaMocks.prepare.mockImplementationOnce(async () => {
      events.push("prepare");
      return {
        url: hostedMediaMocks.url,
        cleanup: hostedMediaMocks.cleanup,
      };
    });
    sendSmsViaTwilio.mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
      await onPlatformSendDispatch?.();
      events.push("send");
      return { sid: "MM-first", to };
    });
    const ctx = mediaContext({
      mediaLocalRoots: ["/tmp"],
      onPlatformSendDispatch: async () => {
        events.push("dispatch");
      },
    });

    await smsPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
    events.push("platform-start");
    await smsPlugin.message?.send?.media?.(ctx);

    expect(hostedMediaMocks.prepare).toHaveBeenCalledOnce();
    expect(events).toEqual(["prepare", "platform-start", "dispatch", "send"]);
    await expect(smsPlugin.message?.send?.media?.(ctx)).rejects.toThrow(
      "SMS message lifecycle did not prepare the MMS attachment.",
    );
  });

  it.each(["durable marker", "final Twilio fence"] as const)(
    "discards staged MMS media when the %s blocks dispatch",
    async (failurePoint) => {
      if (failurePoint === "final Twilio fence") {
        sendSmsViaTwilio.mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          throw new PlatformMessageNotDispatchedError(
            "credentials changed before Twilio dispatch",
            { cause: new Error("credentials changed") },
          );
        });
      }
      const ctx = mediaContext({
        onPlatformSendDispatch: async () => {
          if (failurePoint === "durable marker") {
            throw new Error("delivery marker failed");
          }
        },
      });
      const lifecycle = smsPlugin.message?.send?.lifecycle;
      const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);
      const observed = await smsPlugin.message?.send?.media?.(ctx).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(observed).toBeInstanceOf(PlatformMessageNotDispatchedError);
      await lifecycle?.afterSendFailure?.({ ...ctx, error: observed, attemptToken });
      expect(hostedMediaMocks.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("discards staged MMS media when core fails before entering the adapter", async () => {
    const ctx = mediaContext();
    const lifecycle = smsPlugin.message?.send?.lifecycle;
    const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);

    await lifecycle?.afterSendFailure?.({
      ...ctx,
      error: new Error("queue state rejected before adapter dispatch"),
      attemptToken,
    });

    expect(hostedMediaMocks.cleanup).toHaveBeenCalledOnce();
    expect(sendSmsViaTwilio).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains staged MMS media after dispatch (partial: %s)",
    async (partial) => {
      const failure = new Error("Twilio response was lost");
      if (partial) {
        sendSmsViaTwilio.mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          return { sid: "MM-first", to };
        });
      }
      sendSmsViaTwilio.mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
        if (partial) {
          throw new PlatformMessageNotDispatchedError("second chunk rejected before dispatch", {
            cause: new Error("provider rejected chunk"),
          });
        }
        await onPlatformSendDispatch?.();
        throw failure;
      });
      const ctx = mediaContext({
        config: partial ? { textChunkLimit: 5 } : {},
        text: partial ? "alpha beta" : "caption",
        onPlatformSendDispatch: async () => undefined,
      });
      const lifecycle = smsPlugin.message?.send?.lifecycle;
      const attemptToken = await lifecycle?.beforeSendAttempt?.(ctx);
      const observed = await smsPlugin.message?.send?.media?.(ctx).catch((error: unknown) => error);

      if (partial) {
        expect(isChannelPartialDeliveryError(observed)).toBe(true);
      } else {
        expect(observed).toBe(failure);
      }
      await lifecycle?.afterSendFailure?.({ ...ctx, error: observed, attemptToken });

      expect(hostedMediaMocks.cleanup).not.toHaveBeenCalled();
    },
  );

  it("reports an accepted text chunk before a later durable send fails", async () => {
    const fixture = createPartialSmsSend(sendSmsViaTwilio, "SM-first", "text");
    const { onPlatformSendDispatch, onDeliveryResult } = fixture;

    const observed = await smsPlugin.message?.send
      ?.text?.({
        cfg: createConfig({ textChunkLimit: 5 }),
        to: TO,
        text: "alpha beta",
        onPlatformSendDispatch,
        onDeliveryResult,
      })
      .catch((error: unknown) => error);

    fixture.expectPartial(observed);
  });
});
