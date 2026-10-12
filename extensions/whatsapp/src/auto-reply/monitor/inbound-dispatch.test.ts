import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { loadWebMedia } from "../../media.js";
import { deliverWebReply } from "../deliver-reply.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
  prepareWhatsAppInboundContext,
  resolveWhatsAppDmRouteTarget,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { resolveWhatsAppResponsePrefix } from "./response-prefix.js";

const { readAgentRunTerminalOutcome } = vi.hoisted(() => ({
  readAgentRunTerminalOutcome: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  readAgentRunTerminalOutcome,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  getAgentScopedMediaLocalRoots: () => [],
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));
vi.mock("../../media.js", () => ({ loadWebMedia: vi.fn() }));

type Params = Parameters<typeof createWhatsAppReplyPlan>[0];
type PrepareParams = Parameters<typeof prepareWhatsAppInboundContext>[0];
type Message = PrepareParams["msg"];
type MessageOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;
type Payload = Parameters<ReturnType<typeof createWhatsAppReplyPlan>["delivery"]["deliver"]>[0];
type Kind = "tool" | "block" | "final";

function route(overrides: Partial<Params["route"]> = {}): Params["route"] {
  return {
    agentId: "main",
    channel: "whatsapp",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:direct:+1000",
    mainSessionKey: "agent:main:whatsapp:direct:+1000",
    lastRoutePolicy: "main",
    matchedBy: "default",
    ...overrides,
  };
}
function message(overrides: MessageOverrides = {}): Message {
  return createTestWebInboundMessage({
    ...overrides,
    event: { id: "msg1", ...overrides.event },
    payload: { body: "hi", ...overrides.payload },
    platform: { chatJid: "+1000", recipientJid: "+2000", ...overrides.platform },
    admission: {
      accountId: "default",
      conversation: { kind: "direct", id: "+1000" },
      ...overrides.admission,
    },
  });
}
function prepare(overrides: Partial<PrepareParams> = {}) {
  return prepareWhatsAppInboundContext({
    combinedBody: "hi",
    msg: message(),
    route: route(),
    sender: { e164: "+1000" },
    ...overrides,
  });
}
function accepted() {
  const result = createAcceptedWhatsAppSendResult("text", "wa-sent-1");
  return { results: [result], receipt: result.receipt!, providerAccepted: true };
}
async function fixture(overrides: Partial<Params> & { msg?: Message } = {}) {
  const { msg = message(), ...params } = overrides;
  const deliverReply = vi.fn<Params["deliverReply"]>(async () => accepted());
  const replyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const { inbound } = await prepare({ msg });
  const plan = createWhatsAppReplyPlan({
    cfg: { channels: { whatsapp: { streaming: { block: { enabled: true } } } } },
    connectionId: "conn",
    context: { Body: "hi", CommandAuthorized: false },
    deliverReply,
    maxMediaBytes: 1,
    conversationId: inbound.conversation.id,
    replyLogger: replyLogger as never,
    replyPipeline: {},
    replyResolver: async () => undefined,
    route: route(),
    transport: buildWhatsAppInboundTransportContext(msg),
    ...params,
  });
  const preparePayload = async (payload: Payload, kind: Kind) =>
    plan.delivery.preparePayload ? plan.delivery.preparePayload(payload, { kind }) : payload;
  const deliver = async (
    payload: Payload,
    kind: Kind = "final",
  ): Promise<Awaited<ReturnType<typeof plan.delivery.deliver>>> => {
    const prepared = await preparePayload(payload, kind);
    if (prepared === null) {
      return { visibleReplySent: false };
    }
    const result = await plan.delivery.deliver(prepared, { kind });
    void result?.finalization?.catch(() => undefined);
    await plan.delivery.onDelivered?.(prepared, { kind }, result);
    return result;
  };
  return { plan, deliver, preparePayload, deliverReply, replyLogger };
}
function nonPortablePaths(value: unknown, path = "inbound", seen = new Set<object>()): string[] {
  if (typeof value === "function") {
    return [path];
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return [
    ...Object.getOwnPropertySymbols(value).map((symbol) => `${path}.${String(symbol)}`),
    ...Object.entries(value).flatMap(([key, child]) =>
      nonPortablePaths(child, `${path}.${key}`, seen),
    ),
  ];
}
const toolMedia = { text: "tool image", mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"] };
const replacement = { text: "captioned replacement", mediaUrls: ["/tmp/a.jpg"] };

beforeEach(() => {
  readAgentRunTerminalOutcome.mockReset();
  vi.mocked(loadWebMedia).mockReset();
});

describe("prepared WhatsApp inbound boundary", () => {
  it("projects portable group facts and self identity without transport callbacks", async () => {
    const msg = message({
      platform: { fromMe: true },
      event: { id: "current-1", timestamp: 1_710_000_000 },
      payload: {
        body: "agent body",
        commandBody: "/status",
        media: { path: "/tmp/photo.jpg", type: "image/jpeg", kind: "image" },
      },
      admission: {
        conversation: { kind: "group", id: "123@g.us" },
        senderAccess: { reasonCode: "group_policy_allowed" },
      },
      groupMention: { wasMentioned: false, requireMention: false },
      group: { subject: "Boundary Room", participants: ["15550001111@s.whatsapp.net"] },
    });
    const prepared = await prepare({
      msg,
      bodyForAgent: "agent body",
      combinedBody: "formatted agent body",
      command: {
        kind: "text-slash",
        body: "/status",
        authorized: false,
      },
      route: route({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { id: "+15550001111", name: "Alice", e164: "+15550001111" },
      transcript: "prepared transcript",
      groupMemberRoster: new Map([["+15550001111", "Alice"]]),
      mediaTranscribedIndexes: [0],
      visibleReplyTo: { id: "quoted-1", body: "quoted body", sender: { label: "Bob" } },
      replyThreading: { implicitCurrentMessage: "allow" },
      suppressMessageReceivedHooks: true,
    });
    expect(prepared.inbound).toMatchObject({
      messageId: "current-1",
      timestamp: 1_710_000_000,
      message: {
        body: "formatted agent body",
        bodyForAgent: "agent body",
        rawBody: "agent body",
        commandBody: "/status",
      },
      sender: { id: "+15550001111", isSelf: true },
      conversation: { kind: "group", id: "123@g.us", label: "123@g.us" },
      reply: { replyToId: "quoted-1" },
      command: {
        kind: "text-slash",
        body: "/status",
        authorized: false,
      },
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg", kind: "image", transcribed: true },
      ],
      extra: {
        Transcript: "prepared transcript",
        GroupSubject: "Boundary Room",
        SenderE164: "+15550001111",
        ReplyThreading: { implicitCurrentMessage: "allow" },
      },
    });
    expect(prepared.ctxPayload).toMatchObject({
      MessageSid: "current-1",
      BodyForAgent: "agent body",
      RawBody: "agent body",
      CommandBody: "/status",
      ReplyToId: "quoted-1",
      Transcript: "prepared transcript",
      SenderId: "+15550001111",
      SenderIsSelf: true,
      ConversationLabel: "123@g.us",
      GroupSubject: "Boundary Room",
      GroupMembers: "Alice (+15550001111)",
      CommandAuthorized: false,
      SuppressMessageReceivedHooks: true,
    });
    expect(nonPortablePaths(prepared.inbound)).toEqual([]);
    expect(prepared.inbound).not.toHaveProperty("platform");
    expect(prepared.inbound).not.toHaveProperty("admission");
    const transport = buildWhatsAppInboundTransportContext(msg);
    expect(transport).toMatchObject({
      accountId: "default",
      conversationId: "123@g.us",
      conversationKind: "group",
      chatJid: "+1000",
      recipientJid: "+2000",
      correlationId: "current-1",
    });
    expect(transport.reply).toBe(msg.platform.reply);
    expect(transport.sendMedia).toBe(msg.platform.sendMedia);
    expect(transport.sendComposing).toBe(msg.platform.sendComposing);
    expect(transport).not.toHaveProperty("wasMentioned");
  });

  it("assigns unique portable identities without inventing native message IDs", async () => {
    const msg = message({ event: { id: undefined, timestamp: 1_710_000_000 } });
    const params = { msg, sender: { id: "+15550001111" } };
    const [first, second] = await Promise.all([prepare(params), prepare(params)]);
    expect(first.inbound.messageId).not.toBe(second.inbound.messageId);
    const { plan } = await fixture({
      msg,
      conversationId: first.inbound.conversation.id,
      context: { CommandAuthorized: false, ReplyToId: "quoted-bot-message" },
    });
    if (typeof plan.delivery.durable !== "function") {
      throw new Error("expected durable delivery policy");
    }
    expect(await plan.delivery.durable({ text: "final payload" }, { kind: "final" })).toMatchObject(
      { replyToId: null },
    );
    expect(buildWhatsAppInboundTransportContext(msg).correlationId).toBeUndefined();
  });

  it("keeps a remote voice transcript independent of its empty command body", async () => {
    const { ctxPayload } = await prepare({
      bodyForAgent: "spoken transcript",
      combinedBody: "spoken transcript",
      rawBody: "",
      transcript: "spoken transcript",
      command: { kind: "normal", body: "", authorized: false },
      msg: message({
        payload: {
          body: "",
          media: {
            url: "https://media.example/voice.ogg",
            type: "audio/ogg; codecs=opus",
            kind: "audio",
          },
        },
      }),
    });
    expect(ctxPayload).toMatchObject({
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "",
      CommandBody: "",
      RawBody: "",
      Transcript: "spoken transcript",
      media: [
        expect.objectContaining({
          url: "https://media.example/voice.ogg",
          contentType: "audio/ogg; codecs=opus",
        }),
      ],
    });
  });
});

describe("WhatsApp reply delivery", () => {
  it("does not force a self-chat response prefix without identity", () => {
    expect(
      resolveWhatsAppResponsePrefix({ cfg: { messages: {} }, agentId: "main", isSelfChat: true }),
    ).toBeUndefined();
  });

  it("retains the approved batch when a partial replacement is cancelled", async () => {
    const { plan, deliver, preparePayload, deliverReply } = await fixture();
    const deferred = await deliver(toolMedia, "tool");
    const prepared = await preparePayload(replacement, "block");
    expect(prepared).not.toBeNull();
    await plan.delivery.onDelivered?.(
      replacement,
      { kind: "block" },
      { visibleReplySent: false, suppression: { reason: "cancelled_by_message_sending_hook" } },
    );
    await plan.dispatcherOptions.onSettled?.();
    await expect(deferred?.finalization).resolves.toMatchObject({ visibleReplySent: true });
    expect(deliverReply).toHaveBeenCalledOnce();
    expect(deliverReply.mock.calls[0]?.[0].replyResult).toMatchObject({
      mediaUrls: toolMedia.mediaUrls,
      text: undefined,
    });
  });

  it("drops deferred media after a visible replacement fails bookkeeping", async () => {
    const error = Object.assign(new Error("post-send bookkeeping failed"), {
      sentBeforeError: true,
      visibleReplySent: true,
    });
    const deliverReply = vi.fn<Params["deliverReply"]>(async ({ onMediaAccepted }) => {
      onMediaAccepted?.("/tmp/a.jpg");
      throw error;
    });
    const { plan, deliver } = await fixture({ deliverReply });
    const deferred = await deliver({ mediaUrls: ["/tmp/a.jpg"] }, "tool");
    const failed = await deliver(replacement, "block").catch((caught: unknown) => caught);
    await plan.dispatcherOptions.onSettled?.();
    await expect(deferred?.finalization).resolves.toEqual({ visibleReplySent: false });
    expect(deliverReply).toHaveBeenCalledOnce();
    expect(failed).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { content: "captioned replacement", visibleReplySent: true },
      sentBeforeError: true,
      visibleReplySent: true,
      cause: error,
    });
  });

  it.each([
    { failIndex: 0, acceptedBeforeError: false, remainder: ["/tmp/a.jpg"] },
    { failIndex: 1, acceptedBeforeError: false, remainder: ["/tmp/b.jpg"] },
    { failIndex: 0, acceptedBeforeError: true, remainder: ["/tmp/b.jpg"] },
  ])(
    "retains unsent attachments after upload $failIndex fails (accepted=$acceptedBeforeError)",
    async ({ failIndex, acceptedBeforeError, remainder }) => {
      const sent: string[] = [];
      let attempt = 0;
      vi.mocked(loadWebMedia).mockImplementation(async (url) => ({
        buffer: Buffer.from(url),
        contentType: "image/jpeg",
        kind: "image",
      }));
      const sendMedia: Message["platform"]["sendMedia"] = async (content) => {
        if (!("image" in content) || !Buffer.isBuffer(content.image)) {
          throw new Error("expected image transport payload");
        }
        const url = content.image.toString();
        if (attempt++ === failIndex) {
          const error = new Error("upload failed");
          if (acceptedBeforeError) {
            sent.push(url);
            throw createChannelPartialDeliveryError(error, {
              visibleReplySent: true,
              messageIds: ["accepted-before-error"],
            });
          }
          throw error;
        }
        sent.push(url);
        return createAcceptedWhatsAppSendResult("media", `accepted-${attempt}`);
      };
      const reply = vi.fn<Message["platform"]["reply"]>(async () =>
        createAcceptedWhatsAppSendResult("text", "warning"),
      );
      const deliverReply = vi.fn(deliverWebReply);
      const { plan, deliver } = await fixture({
        deliverReply,
        msg: message({ platform: { sendMedia, reply } }),
      });
      const deferred = await deliver(toolMedia, "tool");
      const [replacementResult] = await Promise.allSettled([
        deliver({ ...replacement, mediaUrls: toolMedia.mediaUrls }, "block"),
      ]);
      await plan.dispatcherOptions.onSettled?.();
      expect(deliverReply.mock.calls.map(([params]) => params.replyResult.mediaUrls)).toEqual([
        toolMedia.mediaUrls,
        remainder,
      ]);
      expect(sent.toSorted()).toEqual(toolMedia.mediaUrls);
      await expect(deferred?.finalization).resolves.toMatchObject({ visibleReplySent: true });
      if (acceptedBeforeError) {
        expect(replacementResult).toMatchObject({
          status: "rejected",
          reason: { code: "CHANNEL_PARTIAL_DELIVERY", deliveryResult: { visibleReplySent: true } },
        });
        expect(reply).not.toHaveBeenCalled();
      } else {
        expect(replacementResult).toMatchObject({
          status: "fulfilled",
          value: { visibleReplySent: true },
        });
        expect(reply).toHaveBeenCalledOnce();
        expect(reply.mock.calls[0]?.[0]).toContain("⚠️ Media");
      }
    },
  );

  it.each([
    { replyToId: "explicit", expected: "explicit" },
    { replyToId: undefined, expected: "trigger-message" },
    { replyToId: null, expected: null },
  ])(
    "resolves durable reply target $replyToId without quoting the earlier bot reply",
    async ({ replyToId, expected }) => {
      const { plan } = await fixture({
        context: {
          CommandAuthorized: false,
          ReplyToId: "quoted-bot-message",
          ReplyToBody: "Earlier bot reply",
          ReplyToSender: "OpenClaw",
        },
        msg: message({ event: { id: "trigger-message" } }),
      });
      if (typeof plan.delivery.durable !== "function") {
        throw new Error("expected durable delivery policy");
      }
      // Preserve the existing fixture's explicit no-native-reply sentinel.
      const payload = { text: "final payload", replyToId } as unknown as Payload;
      expect(await plan.delivery.durable(payload, { kind: "final" })).toMatchObject({
        to: "+1000",
        replyToId: expected,
      });
    },
  );

  it("settles the entire deferred tail when a flush fails after an accepted send", async () => {
    const error = new Error("second deferred media failed");
    const deliverReply = vi
      .fn<Params["deliverReply"]>()
      .mockResolvedValueOnce(accepted())
      .mockRejectedValueOnce(error);
    const { plan, deliver } = await fixture({ deliverReply });
    const first = await deliver({ mediaUrls: ["/tmp/first.jpg"] }, "tool");
    const second = await deliver({ mediaUrls: ["/tmp/second.jpg"] }, "tool");
    const third = await deliver({ mediaUrls: ["/tmp/third.jpg"] }, "tool");
    const settlements = Promise.allSettled([
      first?.finalization,
      second?.finalization,
      third?.finalization,
    ]);
    await expect(plan.dispatcherOptions.onSettled?.()).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
      cause: error,
    });
    expect(error).not.toHaveProperty("sentBeforeError");
    expect(error).not.toHaveProperty("visibleReplySent");
    const [one, two, three] = await settlements;
    expect(one).toMatchObject({ status: "fulfilled", value: { visibleReplySent: true } });
    expect(two).toEqual({ status: "rejected", reason: error });
    expect(three).toMatchObject({ status: "rejected", reason: { cause: error } });
    if (three.status === "rejected") {
      expect(three.reason).not.toHaveProperty("sentBeforeError");
      expect(three.reason).not.toHaveProperty("visibleReplySent");
    }
    expect(deliverReply).toHaveBeenCalledTimes(2);
  });

  it("marks downstream failures visible after deferred media flushes", async () => {
    const { plan, deliver, preparePayload, deliverReply } = await fixture();
    await expect(deliver(toolMedia, "tool")).resolves.toMatchObject({ visibleReplySent: false });
    await preparePayload({ text: "final text" }, "final");
    const error = new Error("durable text failed");
    plan.delivery.onError?.(error, { kind: "final" });
    expect(error).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
    expect(deliverReply).toHaveBeenCalledOnce();
  });

  it("suppresses reasoning and compaction payloads", async () => {
    const { deliver, deliverReply } = await fixture();
    await deliver({ text: "hidden", isReasoning: true }, "block");
    await deliver({ text: "🧹 Compacting context...", isCompactionNotice: true }, "block");
    expect(deliverReply).not.toHaveBeenCalled();
  });
  it("suppresses text that normalizes to no visible content", async () => {
    const { deliver, deliverReply } = await fixture();
    await deliver({
      text: '<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>',
    });
    expect(deliverReply).not.toHaveBeenCalled();
  });
  it("delivers final errors with receipt-backed visibility", async () => {
    const { deliver, deliverReply } = await fixture();
    await expect(deliver({ text: "provider exploded", isError: true })).resolves.toMatchObject({
      content: "provider exploded",
      messageIds: ["wa-sent-1"],
      visibleReplySent: true,
    });
    expect(deliverReply).toHaveBeenCalledOnce();
  });
  it("suppresses block error noise", async () => {
    const { deliver, deliverReply } = await fixture();
    await deliver({ text: "tool call failed", isError: true }, "block");
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      mentioned: false,
      command: false,
      mode: "message_tool_only",
      suppressTyping: true,
      disableBlockStreaming: true,
    },
    {
      mentioned: true,
      command: false,
      mode: "message_tool_only",
      suppressTyping: false,
      disableBlockStreaming: true,
    },
    {
      mentioned: false,
      command: true,
      mode: "automatic",
      suppressTyping: false,
      disableBlockStreaming: false,
    },
  ])(
    "selects group delivery for mentioned=$mentioned command=$command",
    async ({ mentioned, command, mode, suppressTyping, disableBlockStreaming }) => {
      const { plan } = await fixture({
        cfg: {
          channels: { whatsapp: { streaming: { block: { enabled: true } } } },
          messages: { groupChat: { visibleReplies: "message_tool" } },
        },
        context: {
          Body: command ? "/status" : "hi",
          ChatType: "group",
          WasMentioned: mentioned,
          CommandAuthorized: command,
          ...(command ? { CommandSource: "text" } : {}),
        },
      });
      expect(plan.replyOptions).toMatchObject({
        sourceReplyDeliveryMode: mode,
        suppressTyping,
        disableBlockStreaming,
      });
    },
  );
  it("keeps visible delivery successful while marking a failed run as an error", async () => {
    let restored!: () => void;
    const restoration = new Promise<void>((resolve) => {
      restored = resolve;
    });
    const controller = {
      setQueued: vi.fn(),
      setThinking: vi.fn(),
      setTool: vi.fn(),
      setCompacting: vi.fn(),
      cancelPending: vi.fn(),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => {
        restored();
      }),
    };
    readAgentRunTerminalOutcome.mockReturnValueOnce("failed");
    const { plan, deliver, deliverReply } = await fixture({ statusReactionController: controller });
    await deliver({ text: "visible failure" });
    expect(plan.finalize({ queuedFinal: false, counts: { final: 1 } })).toBe(true);
    await restoration;
    expect(deliverReply).toHaveBeenCalledOnce();
    expect(controller.setError).toHaveBeenCalledOnce();
    expect(controller.setDone).not.toHaveBeenCalled();
    expect(controller.restoreInitial).toHaveBeenCalledOnce();
    expect(controller.setError.mock.invocationCallOrder[0]).toBeLessThan(
      controller.restoreInitial.mock.invocationCallOrder[0]!,
    );
  });
  it("does not treat unaccepted provider text as sent", async () => {
    const deliverReply = vi.fn<Params["deliverReply"]>(async () => ({
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 123 },
      providerAccepted: false,
    }));
    const { plan, deliver, replyLogger } = await fixture({ deliverReply });
    await deliver({ text: "final text" });
    expect(plan.finalize({ queuedFinal: false, counts: { final: 1 } })).toBe(false);
    expect(deliverReply).toHaveBeenCalledOnce();
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ replyKind: "final", conversationId: "+1000" }),
      "auto-reply was not accepted by WhatsApp provider",
    );
  });
  it("preserves Error subclass diagnostics in delivery logs", async () => {
    class BoomLikeError extends Error {
      override name = "BoomLikeError";
      output = { statusCode: 408, payload: { error: "Request Time-out" } };
      data = { reason: "transport-stale" };
    }
    const error = new BoomLikeError("send timed out");
    const { plan, replyLogger } = await fixture();
    plan.delivery.onError?.(error, { kind: "final" });
    expect(replyLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: {
          type: "BoomLikeError",
          name: "BoomLikeError",
          message: "send timed out",
          stack: error.stack,
          output: { statusCode: 408, payload: { error: "Request Time-out" } },
          data: { reason: "transport-stale" },
        },
        replyKind: "final",
        correlationId: "msg1",
      }),
      "auto-reply delivery failed",
    );
  });
  it("preserves structured object rejections", async () => {
    const rejection = { error: { message: "wrapped failure", code: "BAILEYS_NACK" }, attempt: 2 };
    const { plan, replyLogger } = await fixture();
    plan.delivery.onError?.(rejection, { kind: "tool" });
    expect(replyLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: rejection, replyKind: "tool", correlationId: "msg1" }),
      "auto-reply delivery failed",
    );
  });
});

describe("WhatsApp main route", () => {
  it.each([
    { target: "+3000", pinned: null, sessionKey: "agent:main:isolated", expected: 0 },
    { target: "+3000", pinned: "+1000", sessionKey: "agent:main:main", expected: 0 },
    { target: "+1000", pinned: "+1000", sessionKey: "agent:main:main", expected: 1 },
  ])(
    "updates only the owner's main route: $target / $sessionKey",
    ({ target, pinned, sessionKey, expected }) => {
      const updateLastRoute = vi.fn();
      updateWhatsAppMainLastRoute({
        backgroundTasks: new Set(),
        cfg: {},
        ctx: { Body: "hello" },
        dmRouteTarget: target,
        pinnedMainDmRecipient: pinned,
        route: route({
          sessionKey,
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: sessionKey === "agent:main:main" ? "main" : "session",
        }),
        updateLastRoute,
        warn: () => {},
      });
      expect(updateLastRoute).toHaveBeenCalledTimes(expected);
    },
  );
  it("uses the DM sender before falling back to the chat JID", () => {
    const msg = message({
      admission: { conversation: { kind: "direct", id: "15550003333@s.whatsapp.net" } },
    });
    expect(
      resolveWhatsAppDmRouteTarget({
        msg,
        senderE164: "+15550002222",
        normalizeE164: (value) => value,
      }),
    ).toBe("+15550002222");
    expect(resolveWhatsAppDmRouteTarget({ msg, normalizeE164: () => null })).toBe("+15550003333");
  });
});
