import type { WAMessage } from "baileys";
import {
  dispatchChannelInboundReply,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "../../inbound/send-api.js";
import { normalizeWhatsAppSendResult } from "../../inbound/send-result.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { deliverWebReply } from "../deliver-reply.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
} from "./inbound-dispatch.js";

const recordChannelActivity = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity,
}));
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: vi.fn(),
}));

type Platform = Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">;
const sessionKey = "agent:main:whatsapp:direct:+1000";
const toJid = "1000@s.whatsapp.net";
const accepted = (id: string, kind: "text" | "media") =>
  normalizeWhatsAppSendResult({ key: { id } } as WAMessage, kind);

function producerApi(messages: WAMessage[]) {
  const sendMessage = vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>();
  for (const message of messages) {
    sendMessage.mockResolvedValueOnce(message);
  }
  return createWebSendApi({
    sock: { sendMessage, sendPresenceUpdate: vi.fn(async () => undefined) },
    defaultAccountId: "default",
  });
}

async function observe(
  platform: Platform,
  payload = { text: "caption", mediaUrls: ["/tmp/media.ogg"] },
  deferredMediaUrls?: string[],
) {
  const pluginHook = vi.fn();
  const internalHook = vi.fn();
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "whatsapp-receipts",
    hookName: "message_sent",
    handler: pluginHook as PluginHookRegistration["handler"],
  });
  initializeGlobalHookRunner(registry);
  registerInternalHook("message:sent", internalHook);
  const msg = createTestWebInboundMessage({
    event: { id: "wa-inbound-1" },
    platform: { chatJid: toJid, recipientJid: "+2000", ...platform },
    admission: { conversation: { kind: "direct", id: "+1000" } },
  });
  const context = {
    Body: "caption",
    From: "+1000",
    To: "+2000",
    SessionKey: sessionKey,
    AccountId: "default",
    CommandAuthorized: false,
  };
  const replyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const plan = createWhatsAppReplyPlan({
    cfg: { channels: { whatsapp: {} } },
    connectionId: "conn-1",
    context,
    deliverReply: deliverWebReply,
    maxMediaBytes: 1024,
    conversationId: "+1000",
    replyLogger: replyLogger as never,
    replyPipeline: {},
    replyResolver: async () => undefined,
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
  const onDelivered = vi.fn(plan.delivery.onDelivered);
  let deliveryResult: unknown;
  let settledResult: unknown;
  const failure = await dispatchChannelInboundReply({
    cfg: { channels: { whatsapp: {} } },
    channel: "whatsapp",
    accountId: "default",
    agentId: "main",
    routeSessionKey: sessionKey,
    ctxPayload: context,
    storePath: "/tmp/whatsapp-message-sent-test.json",
    recordInboundSession: async () => undefined,
    dispatchReplyWithBufferedBlockDispatcher: async (dispatch) => {
      dispatch.replyOptions?.onAgentRunStart?.("run-wa-partial");
      if (deferredMediaUrls) {
        const deferred = await dispatch.dispatcherOptions.deliver(
          { text: "tool images", mediaUrls: deferredMediaUrls },
          { kind: "tool" },
        );
        expect(deferred).toMatchObject({
          visibleReplySent: false,
          finalization: expect.any(Promise),
        });
        expect(onDelivered).not.toHaveBeenCalled();
      }
      try {
        deliveryResult = await dispatch.dispatcherOptions.deliver(payload, { kind: "final" });
      } finally {
        settledResult = await dispatch.dispatcherOptions.onSettled?.();
      }
      return { queuedFinal: true, counts: { tool: deferredMediaUrls ? 1 : 0, block: 0, final: 1 } };
    },
    dispatcherOptions: plan.dispatcherOptions,
    delivery: { ...plan.delivery, onDelivered },
    replyOptions: plan.replyOptions,
    replyResolver: plan.replyResolver,
  }).catch((caught: unknown) => caught);
  return {
    deliveryResult,
    failure,
    pluginHook,
    internalHook,
    onDelivered,
    settledResult,
    replyLogger,
  };
}

async function expectObserved(
  result: Awaited<ReturnType<typeof observe>>,
  ids: string[],
  success: boolean,
) {
  await vi.waitFor(() => {
    expect(result.pluginHook).toHaveBeenCalledTimes(ids.length);
    expect(result.internalHook).toHaveBeenCalledTimes(ids.length);
  });
  expect(result.pluginHook.mock.calls.map(([event]) => [event.messageId, event.success])).toEqual(
    ids.map((id) => [id, success]),
  );
  for (const messageId of ids) {
    expect(result.pluginHook).toHaveBeenCalledWith(
      expect.objectContaining({ messageId }),
      expect.objectContaining({ messageId }),
    );
  }
}
function expectActivity() {
  expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
    channel: "whatsapp",
    accountId: "default",
    direction: "outbound",
  });
}
beforeEach(() => {
  recordChannelActivity.mockReset();
});
afterEach(() => {
  clearInternalHooks();
  resetGlobalHookRunner();
});

describe("WhatsApp canonical message_sent delivery", () => {
  it("finalizes deferred attachments in order and exposes both receipts to observers", async () => {
    const sent: string[] = [];
    vi.mocked(loadWebMedia).mockImplementation(async (url) => ({
      buffer: Buffer.from(url),
      contentType: "image/jpeg",
      kind: "image",
    }));
    const sendMedia = vi.fn<Platform["sendMedia"]>(async (content) => {
      if (!("image" in content) || !Buffer.isBuffer(content.image)) {
        throw new Error("expected image transport payload");
      }
      sent.push(content.image.toString());
      return accepted(`sent-${sent.length}`, "media");
    });
    const reply = vi.fn<Platform["reply"]>();
    const result = await observe(
      { reply, sendMedia },
      { text: "Here are the images", mediaUrls: ["/tmp/c.jpg"] },
      ["/tmp/a.jpg", "/tmp/b.jpg"],
    );
    expect(result.failure).toMatchObject({ dispatched: true });
    expect(sent).toEqual(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    expect(reply).not.toHaveBeenCalled();
    expect(result.settledResult).toEqual({ visibleReplySent: true });
    expect(result.onDelivered).toHaveBeenCalledTimes(2);
    const [, info, finalized] = result.onDelivered.mock.calls[1]!;
    expect(info.kind).toBe("tool");
    expect(finalized?.finalization).toBeUndefined();
    expect(finalized).toMatchObject({
      visibleReplySent: true,
      content: "",
      messageIds: ["sent-1", "sent-2"],
      receipt: { platformMessageIds: ["sent-1", "sent-2"] },
    });
    await expectObserved(result, ["sent-3", "sent-1"], true);
  });

  it("accounts once for separate voice and caption sends and publishes their receipts", async () => {
    recordChannelActivity.mockImplementation(() => {
      if (recordChannelActivity.mock.calls.length > 1) {
        throw new Error("duplicate activity");
      }
    });
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const ids = ["voice", "caption"];
    const meta = { fromMe: true, participant: "observer@s.whatsapp.net" };
    const api = producerApi(ids.map((id) => ({ key: { id, remoteJid: toJid, ...meta } })));
    const reply = vi.fn<Platform["reply"]>((text) => api.sendMessage("+1000", text));
    const sendMedia: Platform["sendMedia"] = async (payload) => {
      if (!("audio" in payload) || !Buffer.isBuffer(payload.audio)) {
        throw new Error("expected voice buffer");
      }
      return api.sendMessage("+1000", "", payload.audio, "audio/ogg");
    };
    const result = await observe({ reply, sendMedia });
    expect(result.failure).toMatchObject({
      dispatched: true,
      dispatchResult: { queuedFinal: true },
    });
    expect(result.deliveryResult).toMatchObject({
      messageIds: ids,
      receipt: {
        primaryPlatformMessageId: "voice",
        platformMessageIds: ids,
        parts: ids.map((platformMessageId, index) => ({
          platformMessageId,
          index,
          raw: { toJid, meta: { ...meta, kind: index === 0 ? "media" : "text" } },
        })),
        raw: ids.map((messageId) => ({
          channel: "whatsapp",
          messageId,
          toJid,
          meta: { ...meta, providerAccepted: true },
        })),
      },
    });
    await expectObserved(result, ["voice"], true);
    expect(reply).toHaveBeenCalledExactlyOnceWith("caption", undefined);
    expectActivity();
  });

  it("publishes the accepted receipt even when producer bookkeeping fails", async () => {
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const error = new Error("bookkeeping failed");
    recordChannelActivity.mockImplementationOnce(() => {
      throw error;
    });
    const api = producerApi([{ key: { id: "voice" } }]);
    const sendMedia = () => api.sendMessage("+1000", "", Buffer.from("voice"), "audio/ogg");
    const reply = vi.fn<Platform["reply"]>();
    const result = await observe({ reply, sendMedia });
    expect(isChannelPartialDeliveryError(result.failure)).toBe(true);
    if (!isChannelPartialDeliveryError(result.failure)) {
      throw new Error("expected partial delivery");
    }
    expect(result.failure.deliveryResult).toMatchObject({
      visibleReplySent: true,
      messageIds: ["voice"],
      receipt: { platformMessageIds: ["voice"] },
    });
    expect(result.failure).toHaveProperty("cause", error);
    await expectObserved(result, ["voice"], false);
    expect(reply).not.toHaveBeenCalled();
    expectActivity();
  });
});
