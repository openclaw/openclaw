// WhatsApp tests prove native reply receipts reach the canonical sent-message observers.
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  dispatchChannelInboundReply,
  isChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "../../inbound/send-api.js";
import { normalizeWhatsAppSendResult } from "../../inbound/send-result.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { loadWebMedia } from "../../media.js";
import { deliverWebReply } from "../deliver-reply.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
} from "./inbound-dispatch.js";

const sessionKey = "agent:main:whatsapp:direct:+1000";

const recordChannelActivity = vi.hoisted(() => vi.fn());

function mockMedia(kind: "audio" | "video") {
  vi.mocked(loadWebMedia).mockResolvedValueOnce({
    buffer: Buffer.from(kind === "audio" ? "voice" : "video"),
    contentType: kind === "audio" ? "audio/ogg" : "video/mp4",
    kind,
  });
}

async function expectObserved(
  {
    pluginHook,
    internalHook,
  }: { pluginHook: ReturnType<typeof vi.fn>; internalHook: ReturnType<typeof vi.fn> },
  messageId: string,
  success: boolean,
) {
  await vi.waitFor(() => {
    expect(pluginHook).toHaveBeenCalledOnce();
    expect(internalHook).toHaveBeenCalledOnce();
  });
  expect(pluginHook).toHaveBeenCalledWith(
    expect.objectContaining({ messageId, success }),
    expect.objectContaining({ messageId }),
  );
}

function expectActivity() {
  expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
    channel: "whatsapp",
    accountId: "default",
    direction: "outbound",
  });
}

function guardActivity(message: string) {
  recordChannelActivity.mockReset().mockImplementation(() => {
    if (recordChannelActivity.mock.calls.length > 1) {
      throw new Error(message);
    }
  });
}

function producerApi(messages: WAMessage[]) {
  const sendMessage = vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>();
  for (const message of messages) {
    sendMessage.mockResolvedValueOnce(message);
  }
  return {
    sendMessage,
    sendApi: createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate: vi.fn(async () => undefined) },
      defaultAccountId: "default",
    }),
  };
}

function producerPlatform(kind: "audio" | "video", messages: WAMessage[]) {
  const { sendMessage, sendApi } = producerApi(messages);
  const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();
  if (kind === "audio") {
    reply.mockImplementation((text) => sendApi.sendMessage("+1000", text));
  }
  const sendMedia = vi.fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>(async (payload) => {
    const buffer =
      kind === "audio" && "audio" in payload
        ? payload.audio
        : kind === "video" && "video" in payload
          ? payload.video
          : undefined;
    if (!Buffer.isBuffer(buffer)) {
      throw new Error(`Expected a real WhatsApp ${kind} payload`);
    }
    const caption =
      kind === "video" && "caption" in payload && typeof payload.caption === "string"
        ? payload.caption
        : "";
    const mimetype =
      "mimetype" in payload && typeof payload.mimetype === "string"
        ? payload.mimetype
        : kind === "audio"
          ? "audio/ogg"
          : "video/mp4";
    return sendApi.sendMessage("+1000", caption, buffer, mimetype);
  });
  return { sendMessage, sendMedia, reply };
}

function expectPartialReceipt(failure: unknown, messageIds: string[]) {
  expect(isChannelPartialDeliveryError(failure)).toBe(true);
  if (!isChannelPartialDeliveryError(failure)) {
    throw new Error("Expected a partial WhatsApp delivery");
  }
  expect(failure.deliveryResult).toMatchObject({
    messageIds,
    receipt: { platformMessageIds: messageIds },
  });
  return failure;
}

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

vi.mock("../../media.js", () => ({ loadWebMedia: vi.fn() }));

function createPlan(
  deliverReply: Parameters<typeof createWhatsAppReplyPlan>[0]["deliverReply"],
  platform?: Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">,
) {
  const msg = createTestWebInboundMessage({
    event: { id: "wa-inbound-1" },
    payload: { body: "show me the result" },
    platform: {
      chatJid: "1000@s.whatsapp.net",
      recipientJid: "+2000",
      senderJid: "1000@s.whatsapp.net",
      ...platform,
    },
    admission: {
      accountId: "default",
      conversation: { kind: "direct", id: "+1000" },
      sender: { id: "1000@s.whatsapp.net" },
    },
  });
  const context = {
    Body: "show me the result",
    BodyForAgent: "show me the result",
    RawBody: "show me the result",
    CommandBody: "show me the result",
    From: "+1000",
    To: "+2000",
    SessionKey: sessionKey,
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "+1000",
    AccountId: "default",
    ChatType: "direct",
    CommandAuthorized: false,
  };
  const replyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const plan = createWhatsAppReplyPlan({
    cfg: { channels: { whatsapp: {} } } as never,
    connectionId: "conn-1",
    context,
    deliverReply,
    maxMediaBytes: 1024,
    conversationId: "+1000",
    replyLogger: replyLogger as never,
    replyPipeline: {},
    replyResolver: (async () => undefined) as never,
    route: {
      agentId: "main",
      channel: "whatsapp",
      accountId: "default",
      sessionKey,
      mainSessionKey: sessionKey,
      lastRoutePolicy: "main",
      matchedBy: "default",
    },
    transport: buildWhatsAppInboundTransportContext(msg),
  });
  return { context, plan, replyLogger };
}

async function dispatchObservedPlatformReply(params: {
  payload: { text: string; mediaUrls?: string[] };
  platform: Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">;
  deferredMediaUrls?: string[];
}) {
  const pluginHook = vi.fn();
  const internalHook = vi.fn();
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "whatsapp-message-sent-partial-test",
    hookName: "message_sent",
    handler: pluginHook as PluginHookRegistration["handler"],
  });
  initializeGlobalHookRunner(registry);
  registerInternalHook("message:sent", internalHook);
  const { context, plan, replyLogger } = createPlan(deliverWebReply, params.platform);
  const onDelivered = vi.fn(plan.delivery.onDelivered);
  let deliveryResult: unknown;
  let settledResult: unknown;
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (dispatch) => {
    dispatch.replyOptions?.onAgentRunStart?.("run-wa-partial");
    if (params.deferredMediaUrls) {
      const deferred = await dispatch.dispatcherOptions.deliver(
        { text: "tool images", mediaUrls: params.deferredMediaUrls },
        { kind: "tool" },
      );
      expect(deferred).toMatchObject({
        visibleReplySent: false,
        finalization: expect.any(Promise),
      });
      expect(onDelivered).not.toHaveBeenCalled();
    }
    try {
      deliveryResult = await dispatch.dispatcherOptions.deliver(params.payload, { kind: "final" });
    } finally {
      settledResult = await dispatch.dispatcherOptions.onSettled?.();
    }
    return {
      queuedFinal: true,
      counts: { tool: params.deferredMediaUrls ? 1 : 0, block: 0, final: 1 },
    };
  });
  const failure = await dispatchChannelInboundReply({
    cfg: { channels: { whatsapp: {} } } as never,
    channel: "whatsapp",
    accountId: "default",
    agentId: "main",
    routeSessionKey: sessionKey,
    storePath: "/tmp/whatsapp-message-sent-test.json",
    ctxPayload: context,
    recordInboundSession: async () => undefined,
    dispatchReplyWithBufferedBlockDispatcher,
    dispatcherOptions: plan.dispatcherOptions,
    delivery: { ...plan.delivery, onDelivered },
    replyOptions: plan.replyOptions,
    replyResolver: plan.replyResolver,
  }).catch((caught: unknown) => caught);
  return {
    deliveryResult,
    failure,
    internalHook,
    pluginHook,
    replyLogger,
    onDelivered,
    settledResult,
  };
}

afterEach(() => {
  clearInternalHooks();
  resetGlobalHookRunner();
});

describe("WhatsApp canonical message_sent delivery", () => {
  it("finalizes every deferred attachment through core after replacement", async () => {
    const replacement = ["/tmp/c.jpg"];
    const deferredIds = ["sent-1", "sent-2"];
    const sent: string[] = [];
    vi.mocked(loadWebMedia).mockImplementation(async (url) => ({
      buffer: Buffer.from(url),
      contentType: "image/jpeg",
      kind: "image",
    }));
    const sendMedia = vi.fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>(async (content) => {
      if (!("image" in content) || !Buffer.isBuffer(content.image)) {
        throw new Error("expected image transport payload");
      }
      sent.push(content.image.toString());
      return normalizeWhatsAppSendResult(
        { key: { id: `sent-${sent.length}` } } as WAMessage,
        "media",
      );
    });
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();
    const { failure, pluginHook, internalHook, onDelivered, settledResult } =
      await dispatchObservedPlatformReply({
        payload: { text: "Here are the images", mediaUrls: replacement },
        deferredMediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"],
        platform: { reply, sendMedia },
      });

    expect(failure).toMatchObject({ dispatched: true });
    expect(sent).toEqual(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    expect(reply).not.toHaveBeenCalled();
    expect(settledResult).toEqual({ visibleReplySent: true });
    expect(onDelivered).toHaveBeenCalledTimes(2);
    const [, info, finalized] = onDelivered.mock.calls[1]!;
    expect(info.kind).toBe("tool");
    expect(finalized?.finalization).toBeUndefined();
    expect(finalized).toMatchObject({
      visibleReplySent: true,
      content: "",
      messageIds: deferredIds,
      receipt: { platformMessageIds: deferredIds },
    });
    const observedIds = ["sent-3", "sent-1"];
    await vi.waitFor(() => {
      expect(pluginHook).toHaveBeenCalledTimes(observedIds.length);
      expect(internalHook).toHaveBeenCalledTimes(observedIds.length);
    });
    expect(pluginHook.mock.calls.map(([event]) => [event.messageId, event.success])).toEqual(
      observedIds.map((id) => [id, true]),
    );
  });

  it("preserves accepted voice receipts through real dispatch after caption rejection", async () => {
    recordChannelActivity.mockClear();
    mockMedia("audio");
    const sendMedia = vi.fn(async () =>
      normalizeWhatsAppSendResult({ key: { id: "dispatch-voice-accepted" } } as WAMessage, "media"),
    );
    const reply = vi.fn(async () => normalizeWhatsAppSendResult(undefined, "text"));
    const { plan } = createPlan(deliverWebReply, { reply, sendMedia });
    const delivery = plan.delivery as ChannelInboundTurnPlan["delivery"];

    const failure = expectPartialReceipt(
      await delivery
        .deliver({ text: "caption", mediaUrls: ["/tmp/accepted-voice.ogg"] }, { kind: "final" })
        .catch((caught: unknown) => caught),
      ["dispatch-voice-accepted"],
    );
    expect(failure.deliveryResult.visibleReplySent).toBe(true);
    expect(failure).toHaveProperty("cause", expect.any(PlatformMessageNotDispatchedError));
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith("caption", undefined);
    expectActivity();
  });

  it("records activity once for producer-backed media without duplicate bookkeeping", async () => {
    guardActivity("outer owner duplicated producer activity bookkeeping");
    const messageId = "dispatch-producer-media-guarded";
    const { sendMessage, sendMedia, reply } = producerPlatform("video", [
      {
        key: {
          id: messageId,
          remoteJid: "1000@s.whatsapp.net",
          fromMe: true,
          participant: "observer@s.whatsapp.net",
        },
      },
    ]);
    mockMedia("video");

    const { deliveryResult, failure, internalHook, pluginHook, replyLogger } =
      await dispatchObservedPlatformReply({
        payload: {
          text: "caption",
          mediaUrls: ["/tmp/producer-video.mp4"],
        },
        platform: { reply, sendMedia },
      });

    expect(failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    await expectObserved({ pluginHook, internalHook }, messageId, true);
    expect(deliveryResult).toMatchObject({
      receipt: {
        primaryPlatformMessageId: messageId,
        platformMessageIds: [messageId],
        raw: [
          {
            channel: "whatsapp",
            messageId,
            toJid: "1000@s.whatsapp.net",
            meta: {
              fromMe: true,
              participant: "observer@s.whatsapp.net",
              providerAccepted: true,
            },
          },
        ],
        parts: [
          {
            platformMessageId: messageId,
            index: 0,
            raw: {
              toJid: "1000@s.whatsapp.net",
              meta: {
                fromMe: true,
                participant: "observer@s.whatsapp.net",
              },
            },
          },
        ],
      },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expectActivity();
    recordChannelActivity.mockReset();
  });

  it("shares one logical activity scope across real separately accepted voice and caption sends", async () => {
    guardActivity("caption producer incorrectly repeated logical activity bookkeeping");
    mockMedia("audio");
    const messageIds = ["dispatch-scoped-voice", "dispatch-scoped-caption"];
    const { sendMessage, sendMedia, reply } = producerPlatform(
      "audio",
      messageIds.map((id) => ({
        key: { id, remoteJid: "1000@s.whatsapp.net", fromMe: true },
      })),
    );

    const { deliveryResult, failure, internalHook, pluginHook, replyLogger } =
      await dispatchObservedPlatformReply({
        payload: { text: "voice caption", mediaUrls: ["/tmp/scoped-voice.ogg"] },
        platform: { reply, sendMedia },
      });

    expect(failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    expect(deliveryResult).toMatchObject({
      messageIds,
      receipt: {
        primaryPlatformMessageId: "dispatch-scoped-voice",
        platformMessageIds: messageIds,
        parts: ["media", "text"].map((kind, index) => ({
          platformMessageId: messageIds[index],
          raw: { meta: { kind } },
        })),
        raw: messageIds.map((messageId) => ({ messageId, toJid: "1000@s.whatsapp.net" })),
      },
    });
    await expectObserved({ pluginHook, internalHook }, "dispatch-scoped-voice", true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledExactlyOnceWith("voice caption", undefined);
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expectActivity();
    recordChannelActivity.mockReset();
  });

  it("keeps the first accepted chunk visible to observers when a later chunk throws a nested partial", async () => {
    recordChannelActivity.mockClear();
    const bookkeepingError = new Error("second accepted chunk bookkeeping failed");
    mockMedia("audio");
    const firstChunk = normalizeWhatsAppSendResult(
      { key: { id: "dispatch-first-chunk" } } as WAMessage,
      "media",
    );
    const secondChunk = normalizeWhatsAppSendResult(
      { key: { id: "dispatch-second-chunk" } } as WAMessage,
      "text",
    );
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>().mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [secondChunk.messageId],
        receipt: secondChunk.receipt,
        visibleReplySent: true,
      }),
    );
    const sendMedia = vi
      .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
      .mockResolvedValueOnce(firstChunk);

    const { failure, internalHook, pluginHook } = await dispatchObservedPlatformReply({
      payload: { text: "caption", mediaUrls: ["/tmp/accepted-first-voice.ogg"] },
      platform: { reply, sendMedia },
    });

    expectPartialReceipt(failure, ["dispatch-first-chunk", "dispatch-second-chunk"]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    await expectObserved({ pluginHook, internalHook }, "dispatch-first-chunk", false);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    expectActivity();
  });

  it("preserves inner accepted media receipts and one activity attempt through full dispatch", async () => {
    recordChannelActivity.mockClear();
    const bookkeepingError = new Error("accepted dispatch media bookkeeping failed");
    recordChannelActivity.mockImplementationOnce(() => {
      throw bookkeepingError;
    });
    mockMedia("audio");
    const { sendApi } = producerApi([{ key: { id: "dispatch-nested-media" } }]);
    const sendMedia = vi.fn(async () =>
      sendApi.sendMessage("+1000", "", Buffer.from("voice"), "audio/ogg"),
    );
    const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();

    const { failure, internalHook, pluginHook, replyLogger } = await dispatchObservedPlatformReply({
      payload: { text: "caption", mediaUrls: ["/tmp/accepted-nested-voice.ogg"] },
      platform: { reply, sendMedia },
    });

    expectPartialReceipt(failure, ["dispatch-nested-media"]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    await expectObserved({ pluginHook, internalHook }, "dispatch-nested-media", false);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(replyLogger.warn).not.toHaveBeenCalled();
    expectActivity();
  });
});
