import type { AnyMessageContent, WAMessage } from "baileys";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch as sendBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { whatsappChannelOutbound as outbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { createWebSendApi } from "./inbound/send-api.js";
import { createAcceptedWhatsAppSendResult as acceptedSend } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const mocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
  loadOutboundMediaFromUrl: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return { ...actual, recordChannelActivity: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return { ...actual, loadOutboundMediaFromUrl: mocks.loadOutboundMediaFromUrl };
});

// mock-isolation: Resolve only the synthetic active listeners owned by this delivery suite.
vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: (accountId: string) => mocks.controllers.get(accountId) ?? null,
}));

const cfg = { channels: { whatsapp: {} } } as OpenClawConfig;
const accountId = "default";
const chunkConfig = { channels: { whatsapp: { textChunkLimit: 160 } } };
const mediaFixture = (
  kind: "document" | "image" | "audio",
  fileName: string,
  contentType: string,
  bytes: string,
) => ({ kind, fileName, contentType, buffer: Buffer.from(bytes) });

function installChunkSender(prefix: string) {
  const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>();
  sendMessage.mockImplementation(async () =>
    acceptedSend("text", `${prefix}-${sendMessage.mock.calls.length}`),
  );
  mocks.controllers.set(accountId, {
    getActiveListener: () => ({ sendMessage, sendComposingTo: vi.fn() }),
  });
  return sendMessage;
}

async function drainDefaultWhatsAppDeliveries(stateDir: string) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  await drainPendingDeliveries({
    drainKey: `whatsapp:${accountId}`,
    logLabel: "WhatsApp reconnect drain",
    cfg,
    log,
    stateDir,
    selectEntry: (entry) => ({
      match:
        entry.channel === "whatsapp" && ((entry.accountId ?? "").trim() || accountId) === accountId,
      bypassBackoff:
        typeof entry.lastError === "string" &&
        entry.lastError.includes("No active WhatsApp Web listener"),
    }),
  });
  return log;
}

beforeEach(() => {
  mocks.controllers.clear();
  mocks.loadOutboundMediaFromUrl.mockReset();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "whatsapp",
            outbound,
          }),
          message: whatsappMessageAdapter,
        },
      },
    ]),
  );
});

afterEach(() => {
  mocks.controllers.clear();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it.each(["batch", "payload"] as const)(
  "preserves styles and first-chunk quoting via %s",
  async (route) => {
    await withStateDirEnv("openclaw-whatsapp-styled-reply-", async () => {
      const prefix = route === "batch" ? "part" : "payload";
      const length = route === "batch" ? 340 : 4_200;
      const sendMessage = installChunkSender(prefix);
      const onDeliveryResult = vi.fn();
      const onPlatformSendDispatch = vi.fn(async () => {});
      const text = `**${"x".repeat(length)}**`;
      const common = {
        cfg: chunkConfig,
        to: "+1555",
        replyToId: "quoted",
        replyToMode: "first" as const,
        onDeliveryResult,
      };
      if (route === "batch") {
        const result = await sendBatch({
          ...common,
          channel: "whatsapp",
          payloads: [{ text }],
          durability: "required",
        });
        expect(result.status).toBe("sent");
      } else {
        await outbound.sendPayload!({
          ...common,
          text,
          payload: { text },
          formatting: { textLimit: 80 },
          replyToIdSource: "implicit",
          onPlatformSendDispatch,
        });
      }
      const parts = sendMessage.mock.calls.map(([, part]) => part);
      if (route === "batch") {
        expect(parts).toEqual([158, 158, 24].map((size) => `*${"x".repeat(size)}*`));
        expect(
          onDeliveryResult.mock.calls.map(([progress]) =>
            progress.receipt?.parts.map((part: { replyToId?: string }) => part.replyToId),
          ),
        ).toEqual([["quoted"], [undefined], [undefined]]);
      } else {
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every((part) => /^\*x+\*$/.test(part) && part.length <= 80)).toBe(true);
        expect(parts.map((part) => part.slice(1, -1)).join("")).toBe("x".repeat(length));
        expect(onPlatformSendDispatch).toHaveBeenCalledTimes(parts.length);
      }
      expect(sendMessage.mock.calls.map((call) => call[4]?.quotedMessageKey?.id)).toEqual(
        parts.map((_, index) => (index === 0 ? "quoted" : undefined)),
      );
      expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual(
        parts.map((_, index) => `${prefix}-${index + 1}`),
      );
    });
  },
);

it("preserves accepted receipts and callback order after caption failure", async () => {
  const order: string[] = [];
  const socketSend = vi.fn(async (jid: string, _content: AnyMessageContent) => {
    const sequence = socketSend.mock.calls.length;
    order.push(`socket:${sequence}`);
    if (sequence === 3) {
      throw new Error("fixture transport failed");
    }
    return {
      key: { id: `native-${sequence}`, remoteJid: jid, fromMe: true },
    } as WAMessage;
  });
  const sendApi = createWebSendApi({
    sock: {
      sendMessage: socketSend,
      sendPresenceUpdate: vi.fn(async () => undefined),
    },
    defaultAccountId: accountId,
  });
  mocks.controllers.set(accountId, {
    getActiveListener: () => sendApi,
  });
  const mediaAccess = {
    localRoots: ["/tmp/whatsapp-dispatch-fixture"],
    readFile: vi.fn(async () => Buffer.from("host-read")),
  };
  const mediaLocalRoots = ["/tmp/whatsapp-dispatch-legacy"];
  const mediaReadFile = vi.fn(async () => Buffer.from("legacy-read"));
  const media = {
    "fixture://forced.png": mediaFixture("image", "forced.png", "image/png", "png"),
    "fixture://voice.ogg": mediaFixture("audio", "voice.ogg", "audio/ogg", "ogg"),
  } as const;
  mocks.loadOutboundMediaFromUrl.mockImplementation(async (url: string) => {
    const fixture = media[url as keyof typeof media];
    if (!fixture) {
      throw new Error(`missing fixture: ${url}`);
    }
    return fixture;
  });
  type PayloadContext = Parameters<NonNullable<typeof outbound.sendPayload>>[0];
  const jid = "1555@s.whatsapp.net";
  const progress: string[] = [];
  const sendPayload = (payload: PayloadContext["payload"], extra: Partial<PayloadContext> = {}) =>
    outbound.sendPayload!({
      cfg,
      to: "+1555",
      payload,
      text: payload.text ?? "",
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
      onDeliveryResult: async (result) => {
        progress.push(result.messageId);
        order.push("progress:" + result.messageId);
      },
      ...extra,
    });
  // Native payload variants live in send.test.ts and inbound/send-api.test.ts;
  // this boundary retains the adapter's receipts, media authority and callback order.
  expect(
    await sendPayload(
      { text: "document", mediaUrl: "fixture://forced.png" },
      { forceDocument: true },
    ),
  ).toEqual({ channel: "whatsapp", messageId: "native-1", toJid: jid });
  const failure = await sendPayload({
    text: "caption fails after voice acceptance",
    mediaUrl: "fixture://voice.ogg",
  }).catch((error: unknown) => error);
  expect(progress).toEqual(Array.from({ length: 2 }, (_, index) => `native-${index + 1}`));
  expect(order).toEqual([
    ...Array.from({ length: 2 }, (_, index) => [
      "dispatch",
      `socket:${index + 1}`,
      `progress:native-${index + 1}`,
    ]).flat(),
    "dispatch",
    "socket:3",
  ]);
  expect(mocks.loadOutboundMediaFromUrl.mock.calls).toEqual(
    Object.keys(media).map((url, index) => [
      url,
      {
        maxBytes: 50 * 1024 * 1024,
        optimizeImages: index === 0 ? false : undefined,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
      },
    ]),
  );
  if (!isChannelPartialDeliveryError(failure)) {
    throw new Error("accepted fixture voice delivery did not preserve its receipt");
  }
  expect(failure.deliveryResult).toMatchObject({
    messageIds: ["native-2"],
    receipt: { platformMessageIds: ["native-2"] },
  });
  expect(failure).toHaveProperty(
    "cause",
    expect.objectContaining({
      message: "fixture transport failed",
    }),
  );
});

it.each(["abort", "transport"] as const)(
  "retains accepted chunks after a later %s failure",
  async (failure) => {
    await withStateDirEnv("openclaw-whatsapp-partial-reply-", async () => {
      const controller = new AbortController();
      const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>(async () => {
        if (sendMessage.mock.calls.length > 1) {
          throw new Error("transport failed");
        }
        return acceptedSend("text", "accepted-first");
      });
      mocks.controllers.set(accountId, {
        getActiveListener: () => ({ sendMessage, sendComposingTo: vi.fn() }),
      });
      const result = await sendBatch({
        cfg: chunkConfig,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: `**${"x".repeat(340)}**` }],
        signal: controller.signal,
        onDeliveryResult: () => {
          if (failure === "abort") {
            controller.abort(new Error("cancelled after first part"));
          }
        },
        durability: "required",
      });
      expect(result).toMatchObject({
        status: "partial_failed",
        results: [{ messageId: "accepted-first" }],
        receipt: { platformMessageIds: ["accepted-first"] },
      });
      expect(sendMessage).toHaveBeenCalledTimes(failure === "abort" ? 1 : 2);
    });
  },
);

it("keeps pre-connect recovery replayable, then sends exactly once after connect", async () => {
  await withStateDirEnv("openclaw-whatsapp-delivery-recovery-", async ({ stateDir }) => {
    const initialResult = await sendBatch({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "queued before listener startup" }],
      durability: "required",
    });
    expect(initialResult).toMatchObject({
      status: "failed",
      error: {
        cause: expect.any(PlatformMessageNotDispatchedError),
      },
    });

    const preConnectLog = await drainDefaultWhatsAppDeliveries(stateDir);
    expect(preConnectLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("No active WhatsApp Web listener"),
    );

    const sendMessage = vi.fn(async () => acceptedSend("text", "recovered-message"));
    const listener: ActiveWebListener = {
      sendComposingTo: vi.fn(async () => {}),
      sendMessage,
      sendPoll: vi.fn(async () => acceptedSend("poll", "poll")),
      sendReaction: vi.fn(async () => acceptedSend("reaction", "reaction")),
    };
    const controller = {
      getActiveListener: () => listener,
      getCurrentSock: () => null,
      getSelfIdentity: () => null,
    };
    mocks.controllers.set(accountId, controller);

    await drainDefaultWhatsAppDeliveries(stateDir);
    await drainDefaultWhatsAppDeliveries(stateDir);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "+1555",
      "queued before listener startup",
      undefined,
      undefined,
    );
  });
});
