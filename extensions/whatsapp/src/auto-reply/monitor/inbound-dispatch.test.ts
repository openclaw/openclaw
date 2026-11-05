import { createStatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { deliverWebReply } from "../deliver-reply.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
  prepareWhatsAppInboundContext,
  resolveWhatsAppDmRouteTarget,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

const { readAgentRunTerminalOutcome, verboseLog } = vi.hoisted(() => ({
  readAgentRunTerminalOutcome: vi.fn(),
  verboseLog: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  readAgentRunTerminalOutcome,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  getAgentScopedMediaLocalRoots: () => [],
  logVerbose: verboseLog,
  shouldLogVerbose: () => true,
}));
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: vi.fn(),
}));

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
function statusReactionFixture() {
  const reactions: string[] = [];
  const controller = createStatusReactionController({
    enabled: true,
    adapter: {
      setReaction: async (emoji) => void reactions.push(emoji),
      clearReaction: async () => void reactions.push(""),
    },
    initialEmoji: "👀",
    timing: { doneHoldMs: 0, errorHoldMs: 0 },
  });
  let restored = Promise.withResolvers<void>();
  const restoration = restored.promise;
  const nextRestoration = () => (restored = Promise.withResolvers<void>()).promise;
  const restoreInitial = controller.restoreInitial;
  vi.spyOn(controller, "restoreInitial").mockImplementation(async () => {
    await restoreInitial();
    restored.resolve();
  });
  return { controller, reactions, restoration, nextRestoration };
}
async function reactionPlan(queued = false) {
  const status = statusReactionFixture();
  const reply = await fixture({ statusReactionController: status.controller });
  if (queued) {
    reply.plan.finalize({ deferredToActiveRun: "followup", counts: {} });
    await status.restoration;
  }
  return { ...status, ...reply };
}
function beginQueuedDelivery(plan: ReturnType<typeof createWhatsAppReplyPlan>) {
  const settle = plan.replyOptions.queuedDeliveryCorrelations?.[0]?.begin();
  if (typeof settle !== "function") {
    throw new Error("Expected a source-bound queued delivery correlation");
  }
  return settle;
}
function expectPortable(value: unknown, seen = new Set<object>()) {
  expect(typeof value).not.toBe("function");
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  Object.values(value).forEach((child) => expectPortable(child, seen));
}
const toolMedia = { text: "tool image", mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"] };
const replacement = { text: "captioned replacement", mediaUrls: ["/tmp/a.jpg"] };

beforeEach(() => {
  readAgentRunTerminalOutcome.mockReset();
  verboseLog.mockClear();
  vi.mocked(loadWebMedia).mockReset();
});

describe("prepared WhatsApp inbound boundary", () => {
  it("projects portable group facts and self identity without transport callbacks", async () => {
    const command = { kind: "text-slash", body: "/status", authorized: false } as const;
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
      command,
      route: route({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { id: "+15550001111", name: "Alice", e164: "+15550001111" },
      transcript: "prepared transcript",
      groupMemberRoster: new Map([["+15550001111", "Alice"]]),
      mediaTranscribedIndexes: [0],
      visibleReplyTo: { id: "quoted-1", body: "quoted body", sender: { label: "Bob" } },
      replyThreading: { implicitCurrentMessage: "allow" },
      suppressMessageReceivedHooks: true,
    });
    expect(prepared.inbound.command).toEqual(command);
    expect(prepared.ctxPayload).toMatchObject({
      MessageSid: "current-1",
      Timestamp: 1_710_000_000,
      Body: "formatted agent body",
      BodyForAgent: "agent body",
      RawBody: "agent body",
      CommandBody: "/status",
      SenderId: "+15550001111",
      SenderIsSelf: true,
      ChatType: "group",
      ConversationLabel: "123@g.us",
      ReplyToId: "quoted-1",
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg", kind: "image", transcribed: true },
      ],
      Transcript: "prepared transcript",
      GroupSubject: "Boundary Room",
      SenderE164: "+15550001111",
      ReplyThreading: { implicitCurrentMessage: "allow" },
      GroupMembers: "Alice (+15550001111)",
      CommandAuthorized: false,
      SuppressMessageReceivedHooks: true,
    });
    expectPortable(prepared.inbound);
    expect(prepared.inbound).not.toHaveProperty("platform");
    expect(prepared.inbound).not.toHaveProperty("admission");
  });

  it("assigns unique portable identities without inventing native message IDs", async () => {
    const msg = message({ event: { id: undefined, timestamp: 1_710_000_000 } });
    const [first, second] = await Promise.all([prepare({ msg }), prepare({ msg })]);
    expect(first.inbound.messageId).not.toBe(second.inbound.messageId);
    const { plan } = await fixture({
      msg,
      conversationId: first.inbound.conversation.id,
      context: { CommandAuthorized: false, ReplyToId: "quoted-bot-message" },
    });
    if (typeof plan.delivery.durable !== "function") {
      throw new Error("expected durable delivery policy");
    }
    const target = await plan.delivery.durable({ text: "final payload" }, { kind: "final" });
    expect(target).toMatchObject({ replyToId: null });
    expect(buildWhatsAppInboundTransportContext(msg).correlationId).toBeUndefined();
  });
});

describe("WhatsApp reply delivery", () => {
  it("records visible delivery without logging the reply content", async () => {
    const text = "private WhatsApp reply with confidential account details";
    const { deliver, plan } = await fixture();
    const result = await deliver({ text });
    expect(result?.visibleReplySent).toBe(true);
    expect(
      plan.finalize({ queuedFinal: false, counts: { final: 1 }, observedReplyDelivery: true }),
    ).toBe(true);
    expect(JSON.stringify(verboseLog.mock.calls)).not.toContain(text);
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
    expect(failed).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { content: "captioned replacement", visibleReplySent: true },
      sentBeforeError: true,
      visibleReplySent: true,
      cause: error,
    });
  });

  it.each([
    { failIndex: 0, acceptedBeforeError: false },
    { failIndex: 1, acceptedBeforeError: false },
    { failIndex: 0, acceptedBeforeError: true },
  ])(
    "retains unsent attachments after upload $failIndex fails (accepted=$acceptedBeforeError)",
    async ({ failIndex, acceptedBeforeError }) => {
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
      const { plan, deliver } = await fixture({
        deliverReply: deliverWebReply,
        msg: message({ platform: { sendMedia, reply } }),
      });
      const deferred = await deliver(toolMedia, "tool");
      const [replacementResult] = await Promise.allSettled([
        deliver({ ...replacement, mediaUrls: toolMedia.mediaUrls }, "block"),
      ]);
      await plan.dispatcherOptions.onSettled?.();
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
        },
        msg: message({ event: { id: "trigger-message" } }),
      });
      if (typeof plan.delivery.durable !== "function") {
        throw new Error("expected durable delivery policy");
      }
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
    const finalizations = [];
    for (const name of ["first", "second", "third"]) {
      const finalization = (await deliver({ mediaUrls: [`/tmp/${name}.jpg`] }, "tool"))
        ?.finalization;
      if (!finalization) {
        throw new Error("Expected deferred delivery finalization");
      }
      finalizations.push(finalization);
    }
    const settlements = Promise.allSettled(finalizations);
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
    if (three?.status === "rejected") {
      expect(three.reason).not.toHaveProperty("sentBeforeError");
      expect(three.reason).not.toHaveProperty("visibleReplySent");
    }
    expect(deliverReply).toHaveBeenCalledTimes(2);
  });

  it("marks downstream failures visible after deferred media flushes", async () => {
    const { plan, deliver, preparePayload } = await fixture();
    await expect(deliver(toolMedia, "tool")).resolves.toMatchObject({ visibleReplySent: false });
    await preparePayload({ text: "final text" }, "final");
    const error = new Error("durable text failed");
    plan.delivery.onError?.(error, { kind: "final" });
    expect(error).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });

  it.each<[string, Payload, Kind]>([
    ["reasoning", { text: "hidden", isReasoning: true }, "block"],
    ["compaction", { text: "🧹 Compacting context...", isCompactionNotice: true }, "block"],
    [
      "empty normalized content",
      {
        text: '<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>',
      },
      "final",
    ],
    ["block error noise", { text: "tool call failed", isError: true }, "block"],
  ])("suppresses %s", async (_name, payload, kind) => {
    const { deliver, deliverReply } = await fixture();
    await deliver(payload, kind);
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("selects message-tool-only delivery for a mentioned group message", async () => {
    const { plan } = await fixture({
      cfg: {
        channels: { whatsapp: { streaming: { block: { enabled: true } } } },
        messages: { groupChat: { visibleReplies: "message_tool" } },
      },
      context: {
        Body: "hi",
        ChatType: "group",
        WasMentioned: true,
        CommandAuthorized: false,
      },
    });
    expect(plan.replyOptions).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      suppressTyping: false,
      disableBlockStreaming: true,
    });
  });
  it.each([
    { visibleReplySent: true, emoji: "✅" },
    { visibleReplySent: false, emoji: "❌" },
  ])(
    "waits for queued delivery before showing $emoji (visible=$visibleReplySent)",
    async ({ visibleReplySent, emoji }) => {
      const { plan, reactions, restoration, nextRestoration } = await reactionPlan();
      expect(plan.finalize({ deferredToActiveRun: "followup", counts: {} })).toBe(false);
      await restoration;
      expect(reactions).toEqual(["👀"]);
      const settle = beginQueuedDelivery(plan);
      plan.replyOptions.onAgentRunTerminalOutcome?.("completed");
      expect(reactions).toEqual(["👀"]);
      const completed = nextRestoration();
      settle({ visibleReplySent, failed: false });
      await completed;
      expect(reactions).toEqual(["👀", emoji, "👀"]);
    },
  );
  it("preserves queued delivery settled before the original dispatch finalizes", async () => {
    const { plan, reactions, restoration } = await reactionPlan();
    plan.replyOptions.onAgentRunTerminalOutcome?.("completed");
    beginQueuedDelivery(plan)({ visibleReplySent: true, failed: false });
    expect(reactions).toEqual([]);
    plan.finalize({ deferredToActiveRun: "followup", counts: {} });
    await restoration;
    expect(reactions).toEqual(["✅", "👀"]);
  });
  it.each([
    { outcome: "delivered", visibleReplySent: true, failed: false },
    { outcome: "terminally failed", visibleReplySent: false, failed: true },
  ])("leaves held delivery neutral after a later $outcome receipt", async (terminal) => {
    const { plan, controller, reactions, restoration } = await reactionPlan();
    const clear = vi.spyOn(controller, "clear");
    plan.finalize({ deferredToActiveRun: "followup", counts: {} });
    await restoration;
    const settle = beginQueuedDelivery(plan);
    plan.replyOptions.onAgentRunTerminalOutcome?.("completed");
    settle({ visibleReplySent: false, failed: false, transportPending: true });
    expect(clear).toHaveBeenCalledOnce();
    await clear.mock.results[0]?.value;
    expect(reactions).toEqual(["👀", ""]);
    // Recovery has no source callback; even a retained caller cannot revive finished activity.
    settle(terminal);
    expect(reactions).toEqual(["👀", ""]);
    expect(clear).toHaveBeenCalledOnce();
  });
  it("shows execution failure immediately and does not replace it with delivery success", async () => {
    const { plan, controller, reactions, restoration } = await reactionPlan();
    plan.replyOptions.onAgentRunTerminalOutcome?.("failed");
    await restoration;
    expect(reactions).toEqual(["❌", "👀"]);
    beginQueuedDelivery(plan)({ visibleReplySent: true, failed: false });
    plan.finalize({ deferredToActiveRun: "followup", counts: {} });
    expect(controller.restoreInitial).toHaveBeenCalledOnce();
  });
  it("keeps a deferred retry pending until a silent turn settles", async () => {
    const queued = await reactionPlan(true);
    const { plan } = queued;
    beginQueuedDelivery(plan)();
    expect(queued.reactions).toEqual(["👀"]);
    const completed = queued.nextRestoration();
    plan.replyOptions.onAgentRunTerminalOutcome?.("completed");
    beginQueuedDelivery(plan)({ visibleReplySent: false, failed: false });
    await completed;
    expect(queued.reactions).toEqual(["👀", "❌", "👀"]);
  });
  it("shows an error when an accepted follow-up is evicted before it runs", async () => {
    const { plan, reactions, nextRestoration } = await reactionPlan(true);
    const completed = nextRestoration();
    plan.replyOptions.onFollowupQueueDisposition?.("queue-cap-old");
    await completed;
    expect(reactions).toEqual(["👀", "❌", "👀"]);
  });
  it("keeps a queue-cap rejection failed even when its notice is delivered", async () => {
    const { plan, deliver, reactions, restoration } = await reactionPlan();
    plan.replyOptions.onFollowupQueueDisposition?.("queue-cap-new");
    await deliver({ text: "The message queue is full." });
    expect(plan.finalize({ counts: { final: 1 } })).toBe(true);
    await restoration;
    expect(reactions).toEqual(["❌", "👀"]);
  });
  it("keeps visible delivery successful while marking a failed run as an error", async () => {
    readAgentRunTerminalOutcome.mockReturnValueOnce("failed");
    const { plan, controller, deliver, reactions, restoration } = await reactionPlan();
    await deliver({ text: "visible failure" });
    expect(plan.finalize({ queuedFinal: false, counts: { final: 1 } })).toBe(true);
    await restoration;
    expect(reactions).toEqual(["❌", "👀"]);
    expect(controller.restoreInitial).toHaveBeenCalledOnce();
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
