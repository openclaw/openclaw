import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
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
import { afterEach, expect, it, vi } from "vitest";
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
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity,
}));
vi.mock("../../media.js", () => ({ loadWebMedia: vi.fn() }));

function accepted(id: string, kind: "media" | "text" = "media") {
  return normalizeWhatsAppSendResult({ key: { id } } as WAMessage, kind);
}

async function dispatch(params: {
  payload: { text: string; mediaUrls: string[] };
  platform: Pick<AdmittedWebInboundMessage["platform"], "reply" | "sendMedia">;
  deferredMediaUrls?: string[];
}) {
  const pluginHook = vi.fn();
  const internalHook = vi.fn();
  const registry = createEmptyPluginRegistry();
  addTestHook({
    registry,
    pluginId: "whatsapp-message-sent-test",
    hookName: "message_sent",
    handler: pluginHook as PluginHookRegistration["handler"],
  });
  initializeGlobalHookRunner(registry);
  registerInternalHook("message:sent", internalHook);
  const msg = createTestWebInboundMessage({
    event: { id: "wa-inbound-1" },
    platform: { chatJid: "1000@s.whatsapp.net", recipientJid: "+2000", ...params.platform },
    admission: { conversation: { kind: "direct", id: "+1000" } },
  });
  const context = {
    Body: "show me the result",
    CommandAuthorized: false,
    From: "+1000",
    To: "+2000",
    SessionKey: sessionKey,
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "+1000",
    AccountId: "default",
    ChatType: "direct",
  };
  const plan = createWhatsAppReplyPlan({
    cfg: { channels: { whatsapp: {} } },
    connectionId: "conn-1",
    context,
    deliverReply: deliverWebReply,
    maxMediaBytes: 1024,
    conversationId: "+1000",
    replyLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
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
  let settledResult: unknown;
  const failure = await dispatchChannelInboundReply({
    cfg: { channels: { whatsapp: {} } },
    channel: "whatsapp",
    accountId: "default",
    agentId: "main",
    routeSessionKey: sessionKey,
    storePath: "/tmp/whatsapp-message-sent-test.json",
    ctxPayload: context,
    recordInboundSession: async () => undefined,
    dispatchReplyWithBufferedBlockDispatcher: async (request) => {
      request.replyOptions?.onAgentRunStart?.("run-wa-partial");
      if (params.deferredMediaUrls) {
        const deferred = await request.dispatcherOptions.deliver(
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
        await request.dispatcherOptions.deliver(params.payload, { kind: "final" });
      } finally {
        settledResult = await request.dispatcherOptions.onSettled?.();
      }
      return {
        queuedFinal: true,
        counts: { tool: params.deferredMediaUrls ? 1 : 0, block: 0, final: 1 },
      };
    },
    dispatcherOptions: plan.dispatcherOptions,
    delivery: { ...plan.delivery, onDelivered },
    replyOptions: plan.replyOptions,
    replyResolver: plan.replyResolver,
  }).catch((caught: unknown) => caught);
  return { failure, internalHook, pluginHook, onDelivered, settledResult };
}

afterEach(() => {
  clearInternalHooks();
  resetGlobalHookRunner();
  recordChannelActivity.mockReset();
});

it("finalizes every deferred attachment through core after replacement", async () => {
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
    return accepted(`sent-${sent.length}`);
  });
  const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>();
  const { failure, pluginHook, internalHook, onDelivered, settledResult } = await dispatch({
    payload: { text: "Here are the images", mediaUrls: ["/tmp/c.jpg"] },
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
    messageIds: ["sent-1", "sent-2"],
    receipt: { platformMessageIds: ["sent-1", "sent-2"] },
  });
  await vi.waitFor(() => {
    expect(pluginHook).toHaveBeenCalledTimes(2);
    expect(internalHook).toHaveBeenCalledTimes(2);
  });
  expect(pluginHook.mock.calls.map(([event]) => [event.messageId, event.success])).toEqual([
    ["sent-3", true],
    ["sent-1", true],
  ]);
});

it("keeps the first accepted chunk visible to observers when a later chunk throws a nested partial", async () => {
  const error = new Error("second accepted chunk bookkeeping failed");
  vi.mocked(loadWebMedia).mockResolvedValueOnce({
    buffer: Buffer.from("voice"),
    contentType: "audio/ogg",
    kind: "audio",
  });
  const second = accepted("dispatch-second-chunk", "text");
  const reply = vi.fn<AdmittedWebInboundMessage["platform"]["reply"]>().mockRejectedValueOnce(
    createChannelPartialDeliveryError(error, {
      messageIds: [second.messageId],
      receipt: second.receipt,
      visibleReplySent: true,
    }),
  );
  const sendMedia = vi
    .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
    .mockResolvedValueOnce(accepted("dispatch-first-chunk"));
  const { failure, internalHook, pluginHook } = await dispatch({
    payload: { text: "caption", mediaUrls: ["/tmp/reply.ogg"] },
    platform: { reply, sendMedia },
  });
  expect(isChannelPartialDeliveryError(failure)).toBe(true);
  expect(failure).toMatchObject({
    cause: error,
    deliveryResult: {
      messageIds: ["dispatch-first-chunk", "dispatch-second-chunk"],
      receipt: { platformMessageIds: ["dispatch-first-chunk", "dispatch-second-chunk"] },
    },
  });
  await vi.waitFor(() => {
    expect(pluginHook).toHaveBeenCalledOnce();
    expect(internalHook).toHaveBeenCalledOnce();
  });
  expect(pluginHook).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "dispatch-first-chunk", success: false }),
    expect.objectContaining({ messageId: "dispatch-first-chunk" }),
  );
  expect(sendMedia).toHaveBeenCalledOnce();
  expect(reply).toHaveBeenCalledOnce();
  expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
    channel: "whatsapp",
    accountId: "default",
    direction: "outbound",
  });
});
