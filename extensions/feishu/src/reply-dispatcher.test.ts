import os from "node:os";
import path from "node:path";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

type StreamingSessionStub = {
  active: boolean;
  credentials: unknown;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  closeWithResult: Mock<FeishuStreamingSession["closeWithResult"]>;
  discard: Mock<FeishuStreamingSession["discard"]>;
  isActive: ReturnType<typeof vi.fn>;
};
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted((): StreamingSessionStub[] => []);
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
);
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
}));
vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock };
});
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", async () => {
  const { mergeStreamingText } = await import("./card-test-helpers.js");
  class FeishuStreamingFinalizationError extends Error {
    result: { visibleReplySent: boolean; content?: string; messageId?: string };
    constructor(
      cause: unknown,
      result: { visibleReplySent: boolean; content?: string; messageId?: string },
    ) {
      super(cause instanceof Error ? cause.message : String(cause), { cause });
      this.result = result;
    }
  }
  return {
    mergeStreamingText,
    FeishuStreamingFinalizationError,
    FeishuStreamingSession: class {
      active = false;
      credentials: unknown;
      start = vi.fn(async () => {
        this.active = true;
      });
      update = vi.fn(async () => {});
      closeWithResult = vi.fn<FeishuStreamingSession["closeWithResult"]>(async (text, _options) => {
        this.active = false;
        return {
          visibleReplySent: Boolean(text?.trim()),
          ...(text?.trim() ? { content: text } : {}),
          messageId: "om_stream",
        };
      });
      discard = vi.fn<FeishuStreamingSession["discard"]>(async () => {
        this.active = false;
        return { visibleReplySent: false };
      });
      isActive = vi.fn(() => this.active);
      constructor(_client: unknown, credentials: unknown) {
        this.credentials = credentials;
        streamingInstances.push(this);
      }
    },
  };
});
import { buildFeishuPostMessageContent } from "./markdown.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { FeishuStreamingFinalizationError, type FeishuStreamingSession } from "./streaming-card.js";
import type { FeishuConfig } from "./types.js";
type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;
const imageUrl = "https://example.com/image.png";

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./targets.js");
  vi.doUnmock("./typing.js");
  vi.doUnmock("./streaming-card.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/plugin-runtime");
  vi.resetModules();
});
describe("createFeishuReplyDispatcher streaming behavior", () => {
  type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];

  type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;

  type TypingDispatcherOptions = ReplyDispatcherPlan["dispatcherOptions"] &
    ReplyDispatcherPlan["delivery"];

  beforeEach(() => {
    vi.clearAllMocks();
    streamingStartBackoffUntilByAccount.clear();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue(undefined);
    sendStructuredCardFeishuMock.mockReset().mockResolvedValue(undefined);
    sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "om_card" });
    getGlobalHookRunnerMock.mockReturnValue(null);
    resolveFeishuAccountMock.mockReturnValue(
      createReplyAccount("auto", "partial", "feishu", { httpTimeoutMs: 45_000 }),
    );
    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
          chunkMarkdownTextWithMode: vi.fn((text) => [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  });

  function createReplyAccount(
    renderMode: "auto" | "card",
    streamingMode: "off" | "partial",
    domain: "feishu" | "lark",
    overrides: Partial<FeishuConfig> = {},
  ) {
    return {
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain,
      config: { renderMode, streaming: { mode: streamingMode }, ...overrides },
    };
  }

  function useNonStreamingAutoAccount() {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
  }

  it("honors the account response prefix over channel and global defaults", async () => {
    useNonStreamingAutoAccount();
    const { result } = createDispatcherHarness({
      accountId: "main",
      cfg: {
        messages: { responsePrefix: "[global]" },
        channels: {
          feishu: { responsePrefix: "[root]", accounts: { main: { responsePrefix: "[account]" } } },
        },
      },
    });
    const dispatcher = createReplyDispatcher(toTypingDispatcherOptions(result));
    dispatcher.sendFinalReply({ text: "reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[account] reply" }),
    );
  });

  it("keeps card attribution on the selected-model prefix context", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onModelSelected?.({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "off",
    });
    const delivery = await options.deliver({ text: "reply" }, { kind: "final" });
    await options.onIdle?.();
    await delivery?.finalization;
    expect(stream(0).credentials).toMatchObject({ httpTimeoutMs: 45_000 });
    expect(stream(0).closeWithResult).toHaveBeenCalledWith("reply", {
      note: "Agent: agent | Model: gpt-5.6-luna | Provider: openai",
    });
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses all pre-hook CardKit previews when %s is registered",
    async (hookName) => {
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((name: string) => name === hookName),
      });
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "lark"));
      const { result, options } = createDispatcherHarness();
      await options.onReplyStart?.();
      expect(result.replyOptions.onPartialReply).toBeUndefined();
      expect(result.replyOptions.onReasoningStream).toBeUndefined();
      expect(result.replyOptions.onItemEvent).toBeUndefined();
      expect(result.replyOptions.onCompactionStart).toBeUndefined();
      expect(streamingInstances).toHaveLength(0);
      const delivery = await options.deliver({ text: "accepted final" }, { kind: "final" });
      expect(streamingInstances).toHaveLength(1);
      expect(stream(0).start).toHaveBeenCalledTimes(1);
      await options.onIdle?.();
      await delivery?.finalization;
      expectClosed("accepted final");
    },
  );

  function useNonStreamingBlockAccount() {
    resolveFeishuAccountMock.mockReturnValue(
      createReplyAccount("auto", "off", "feishu", {
        streaming: { mode: "off", block: { enabled: true } },
      }),
    );
  }

  function useStreamingBlockAccount() {
    resolveFeishuAccountMock.mockReturnValue(
      createReplyAccount("auto", "partial", "feishu", {
        streaming: { mode: "partial", block: { enabled: true } },
      }),
    );
  }

  function makeTableText(count: number): string {
    return Array.from({ length: count }, (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`).join(
      "\n\n",
    );
  }

  function expectSend(
    mock: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
    callIndex = 0,
  ) {
    expect(mock.mock.calls[callIndex]?.[0]).toEqual(expect.objectContaining(expected));
  }

  function expectStreamingStartOptions(index: number, expected: Record<string, unknown>) {
    expect(stream(index).start.mock.calls[0]).toEqual([
      "oc_chat",
      "chat_id",
      expect.objectContaining(expected),
    ]);
  }

  function gate<T>() {
    let entered!: () => void;
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const wait = () => {
      entered();
      return promise;
    };
    return { started, resolve, reject, wait };
  }

  function expectNoStaticReply() {
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  }

  function expectClosed(text: string, index = 0) {
    expect(stream(index).closeWithResult).toHaveBeenCalledWith(text, { note: "Agent: agent" });
  }

  function accepted(content: string, messageIds: string[]) {
    return { visibleReplySent: true, content, messageIds };
  }

  function partialDelivery(content: string, messageIds: string[]) {
    return { code: "CHANNEL_PARTIAL_DELIVERY", deliveryResult: accepted(content, messageIds) };
  }

  function createRuntimeLogger() {
    return { log: vi.fn(), error: vi.fn() } as never;
  }

  function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: createRuntimeLogger(),
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      ...overrides,
    });
    return { result, options: toTypingDispatcherOptions(result) };
  }

  function toTypingDispatcherOptions(result: ReplyDispatcherPlan): TypingDispatcherOptions {
    return { ...result.dispatcherOptions, ...result.delivery };
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return value as Record<string, unknown>;
  }

  function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string, argIndex = 0) {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error(`missing ${label} call`);
    }
    return call[argIndex];
  }

  function stream(instanceIndex: number): StreamingSessionStub {
    const instance = streamingInstances[instanceIndex];
    if (!instance) {
      throw new Error(`Expected streaming instance ${instanceIndex}`);
    }
    return instance;
  }

  function firstStreamingCloseText(instanceIndex = 0): string {
    const close = stream(instanceIndex).closeWithResult;
    return String(firstMockArg(close, "streaming close"));
  }

  function streamingUpdateTexts(instanceIndex = 0): string[] {
    return stream(instanceIndex).update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
  }

  it.each(["disabled", "stale seconds"])("suppresses typing for %s messages", async (reason) => {
    if (reason === "disabled") {
      resolveFeishuAccountMock.mockReturnValue(
        createReplyAccount("auto", "partial", "feishu", { typingIndicator: false }),
      );
    }
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_parent",
      messageCreateTimeMs:
        reason === "stale seconds" ? Math.floor((Date.now() - 3 * 60_000) / 1000) : undefined,
    });
    await options.onReplyStart?.();
    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "topic root",
      replyToMessageId: "om_topic_root",
      rootId: "om_topic_root",
      fallback: false,
    },
    {
      name: "quoted reply",
      replyToMessageId: "om_quote_reply",
      rootId: "om_original_msg",
      fallback: true,
    },
  ])(
    "routes $name replies and inbound typing independently",
    async ({ replyToMessageId, rootId, fallback }) => {
      useNonStreamingAutoAccount();
      const { options } = createDispatcherHarness({
        replyToMessageId,
        rootId,
        typingTargetMessageId: "om_topic_child",
        threadReply: true,
        replyInThread: true,
        messageCreateTimeMs: Date.now() - 30_000,
      });
      await options.onReplyStart?.();
      await options.deliver(
        { text: "plain text", mediaUrl: "https://example.com/reply.png" },
        { kind: "final" },
      );
      expectSend(addTypingIndicatorMock, { messageId: "om_topic_child" });
      for (const sender of [sendMessageFeishuMock, sendMediaFeishuMock]) {
        expectSend(sender, {
          replyToMessageId,
          replyInThread: true,
          allowTopLevelReplyFallback: fallback,
        });
      }
    },
  );

  it("splits raw final text at the serialized post byte envelope", async () => {
    useNonStreamingAutoAccount();
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(25_000);
    const text = Array.from({ length: 6_150 }, () => "a").join("\n");
    const { options } = createDispatcherHarness();
    await options.deliver({ text }, { kind: "final" });
    await options.onIdle?.();
    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      const content = buildFeishuPostMessageContent({ messageText: params.text });
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30 * 1024);
    }
  });

  it("budgets full metadata on every static card chunk", async () => {
    const account = resolveFeishuAccountMock();
    resolveFeishuAccountMock.mockReturnValue({
      ...account,
      configured: true,
      config: { ...account.config, renderMode: "card", streaming: { mode: "off" } },
    });
    getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(40_000);
    const create = vi.fn(async (_request: { data: { content: string } }) => ({
      code: 0,
      data: { message_id: `om_envelope_${create.mock.calls.length}` },
    }));
    createFeishuClientMock.mockReturnValue({ im: { message: { create } } });
    const actualSend = await vi.importActual<typeof import("./send.js")>("./send.js");
    sendStructuredCardFeishuMock.mockImplementation(actualSend.sendStructuredCardFeishu);
    const name = "界".repeat(1_100);
    const body = "x".repeat(24_576);
    const { options } = createDispatcherHarness({
      identity: { name },
      requiredMentionTargets: [{ openId: "ou_peer_bot", name: "Peer Bot", key: "" }],
    });
    const delivery = await options.deliver(
      { text: `\`\`\`text\n${body}\n\`\`\`` },
      { kind: "final" },
    );
    await options.onIdle?.();
    await delivery?.finalization;
    expect(create.mock.calls.length).toBeGreaterThan(1);
    const bodies: string[] = [];
    for (const [request] of create.mock.calls) {
      const content = request.data.content;
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30720);
      const card = JSON.parse(content);
      expect(card.header.title.content).toBe(name);
      expect(card.body.elements[2].content).toBe(`<font color='grey'>Agent: ${name}</font>`);
      const markdown = card.body.elements[0].content as string;
      const prefix = "<at id=ou_peer_bot></at> ```text\n";
      expect(markdown.startsWith(prefix)).toBe(true);
      expect(markdown.endsWith("\n```")).toBe(true);
      bodies.push(markdown.slice(prefix.length, -4));
    }
    expect(bodies.join("")).toBe(body);
  });

  it("passes mention-forward targets to non-streaming plain text replies without rewriting body text", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      mentionTargets: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });
    await options.deliver(
      { text: 'plain text <at user_id="ou_body">Body User</at>' },
      { kind: "final" },
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectSend(sendMessageFeishuMock, {
      text: 'plain text <at user_id="ou_body">Body User</at>',
      mentions: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });
  });

  it("puts required bot mentions on every chunk and disables streaming cards", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) =>
      text === "First paragraph." ? ["First ", "paragraph."] : [text],
    );
    const requiredMentionTargets = [{ openId: "ou_peer_bot", name: "Peer Bot", key: "" }];
    const { options } = createDispatcherHarness({ requiredMentionTargets });
    await options.deliver({ text: "First paragraph." }, { kind: "final" });
    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectSend(sendMessageFeishuMock, { text: "First ", mentions: requiredMentionTargets });
    expectSend(sendMessageFeishuMock, { text: "paragraph.", mentions: requiredMentionTargets }, 1);
  });

  const approvalPresentationText = [
    "Plugin bind approval required",
    "Allow Codex to bind this conversation?",
    "- Allow once: `/plugin allow`\n- Deny: `/plugin deny`",
  ].join("\n\n");

  const approvalPresentation = {
    title: "Plugin bind approval required",
    blocks: [
      { type: "text" as const, text: "Allow Codex to bind this conversation?" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Allow once", action: { type: "command" as const, command: "/plugin allow" } },
          { label: "Deny", action: { type: "command" as const, command: "/plugin deny" } },
        ],
      },
    ],
  };

  function presentationCardBodies() {
    return sendCardFeishuMock.mock.calls.map(
      (call) => requireRecord(call[0], "native card send").card,
    );
  }

  it("delivers changed legacy controls even without prose", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    for (const value of ["choice-a", "choice-b"]) {
      const buttons = [{ label: "Continue", value }];
      const delivery = await options.deliver(
        { interactive: { blocks: [{ type: "buttons", buttons }] } },
        { kind: "final" },
      );
      expect(delivery?.visibleReplySent).toBe(true);
    }
    expect(presentationCardBodies().map((card) => JSON.stringify(card))).toEqual([
      expect.stringContaining("choice-a"),
      expect.stringContaining("choice-b"),
    ]);
  });

  it("keeps a status-style fallback reply as its authored text", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "Status: uptime 3h",
        presentationTextMode: "fallback",
        presentation: {
          title: "Status",
          blocks: [
            {
              type: "table",
              caption: "Runtime",
              headers: ["Fact", "Value"],
              rows: [["Uptime", "3h"]],
            },
          ],
        },
      },
      { kind: "final" },
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Status: uptime 3h" }),
    );
  });

  it.each([false, true])(
    "retains media and accepted=%s controls after card failure",
    async (acceptedCard) => {
      useNonStreamingAutoAccount();
      sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_accepted_media" });
      sendCardFeishuMock.mockRejectedValueOnce(
        acceptedCard
          ? createChannelPartialDeliveryError(
              new Error("Feishu card send failed: no message_id returned"),
              { visibleReplySent: true, messageIds: [] },
            )
          : new Error("final card rejected"),
      );
      const { options } = createDispatcherHarness();
      await expect(
        options.deliver(
          {
            text: "Choose an option",
            presentation: approvalPresentation,
            mediaUrl: "https://example.com/accepted.png",
          },
          { kind: "final" },
        ),
      ).rejects.toMatchObject(
        partialDelivery(acceptedCard ? `Choose an option\n\n${approvalPresentationText}` : "", [
          "om_accepted_media",
        ]),
      );
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    },
  );

  it("includes the required peer-bot mention after sanitizing presentation content", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      mentionTargets: [{ openId: "ou_context_user", name: "Context user", key: "" }],
      requiredMentionTargets: [{ openId: "ou_peer_bot", name: "Peer bot", key: "" }],
    });
    const delivered = await options.deliver(
      { text: "Choose <at id=ou_other></at>", presentation: approvalPresentation },
      { kind: "final" },
    );
    const card = JSON.stringify(presentationCardBodies()[0]);
    expect(card).toContain("<at id=ou_peer_bot></at>");
    expect(card).not.toContain("<at id=ou_context_user></at>");
    expect(card).not.toContain("<at id=ou_other></at>");
    expect(card).toContain("&lt;at id=ou_other&gt;&lt;/at&gt;");
    expect(delivered).toMatchObject({ visibleReplySent: true });
  });

  it("does not repeat fallback prose inside its native controls card", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: approvalPresentationText,
        presentationTextMode: "fallback",
        presentation: approvalPresentation,
      },
      { kind: "final" },
    );
    const card = JSON.stringify(presentationCardBodies()[0]);
    expect(card.split("Allow Codex to bind this conversation?")).toHaveLength(2);
    expect(card.split('"Allow once"')).toHaveLength(2);
    expect(card.split('"Deny"')).toHaveLength(2);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps oversized block controls visible alongside voice media before the streaming final", async () => {
    useStreamingBlockAccount();
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_voice" });
    const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    const payload = {
      text: "Pick a run",
      mediaUrl: "https://example.com/answer.ogg",
      audioAsVoice: true,
      presentation: {
        blocks: [
          ...lines.map((text) => ({ type: "text" as const, text })),
          {
            type: "buttons" as const,
            buttons: [
              { label: "Open run", action: { type: "command" as const, command: "/open" } },
            ],
          },
        ],
      },
    };
    const fallbackText = ["Pick a run", ...lines, "- Open run: `/open`"].join("\n\n");
    const finalText = "The run is ready.";
    // Queue both logical payloads before automatic idle. A final may replace
    // ordinary stream text, but it must not erase an earlier controls fallback.
    expect(dispatcher.sendBlockReply(payload)).toBe(true);
    expect(dispatcher.sendFinalReply({ text: finalText })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliveries.map((entry) => entry.kind)).toEqual(["block", "final"]);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    const finalStream = stream(streamingInstances.length - 1);
    expect(finalStream.closeWithResult).toHaveBeenCalledWith(finalText, { note: "Agent: agent" });
    expect(finalStream.discard).not.toHaveBeenCalled();
    const postTexts = sendMessageFeishuMock.mock.calls.map(
      ([params]) => requireRecord(params, "post send").text,
    );
    expect(postTexts).toEqual([fallbackText]);
    const firstDelivery = deliveries[0]?.delivery;
    const settled = (await firstDelivery?.finalization) ?? firstDelivery;
    expect(settled).toMatchObject({ visibleReplySent: true, content: fallbackText });
    expect(settled?.messageIds).toContain("om_voice");
    expect(settled?.messageIds ?? []).not.toContain("om_stream");
  });

  it("preserves full labels in oversized reply controls fallback", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    const label = "Open the complete retained workflow run details";
    const delivery = await options.deliver(
      {
        presentation: {
          blocks: [
            ...Array.from({ length: 200 }, () => ({ type: "divider" as const })),
            {
              type: "buttons",
              buttons: [{ label, action: { type: "command", command: "/open-run" } }],
            },
          ],
        },
      },
      { kind: "final" },
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(delivery?.visibleReplySent).toBe(true);
    expect(requireRecord(sendMessageFeishuMock.mock.calls[0]?.[0], "post send").text).toBe(
      `- ${label}: \`/open-run\``,
    );
  });

  type RecordedFeishuDelivery = {
    kind: "tool" | "block" | "final";
    delivery: Awaited<ReturnType<TypingDispatcherOptions["deliver"]>>;
  };

  function createRecordedFeishuDispatcher(onDelivered?: (kind: string) => void) {
    const { result, options } = createDispatcherHarness();
    const deliveries: RecordedFeishuDelivery[] = [];
    const entered = vi.fn();
    const dispatcher = createReplyDispatcher({
      ...options,
      deliver: async (payload, info) => {
        entered(info.kind);
        const delivery = await options.deliver(payload, info);
        if (delivery?.finalization) {
          void delivery.finalization.catch(() => undefined);
        }
        deliveries.push({ kind: info.kind, delivery });
        onDelivered?.(info.kind);
        return delivery;
      },
    });
    return { result, options, dispatcher, deliveries, entered };
  }

  it.each([
    {
      error: false,
      text: "The earlier answer paragraph.",
      controlsText: "Choose the next action.",
      kinds: ["block", "tool"],
    },
    {
      error: true,
      text: "The file is ready.",
      controlsText: "⚠️ Exec failed",
      kinds: ["final", "final"],
    },
  ])(
    "preserves committed text before controls with error=$error",
    async ({ error, text, controlsText, kinds }) => {
      if (error) {
        getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(40);
      } else {
        useStreamingBlockAccount();
      }
      const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
      expect(
        error ? dispatcher.sendFinalReply({ text }) : dispatcher.sendBlockReply({ text }),
      ).toBe(true);
      const controls = {
        text: controlsText,
        presentation: approvalPresentation,
        ...(error ? { isError: true } : {}),
      };
      expect(
        error ? dispatcher.sendFinalReply(controls) : dispatcher.sendToolResult(controls),
      ).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(deliveries.map((entry) => entry.kind)).toEqual(kinds);
      await expect(deliveries[0]?.delivery?.finalization).resolves.toMatchObject(
        accepted(text, ["om_stream"]),
      );
      expect(deliveries[1]?.delivery).toMatchObject(
        accepted(`${controlsText}\n\n${approvalPresentationText}`, ["om_card"]),
      );
      expect(stream(0).discard).not.toHaveBeenCalled();
      expectClosed(text);
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(JSON.stringify(presentationCardBodies()[0])).not.toContain(text);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("suppresses discarded block prose while retaining accepted media", async () => {
    sendMediaFeishuMock.mockResolvedValue({ messageId: "om-block-media" });
    sendCardFeishuMock.mockResolvedValue({ messageId: "om-final-controls" });
    const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
    const obsoleteText = "```text\nobsolete streaming paragraph\n```";
    // Both payloads enter the real serialized queue before it drains. The old
    // block returns deferred settlement; the final replaces its preview before idle.
    const blockQueued = dispatcher.sendBlockReply({
      text: obsoleteText,
      mediaUrl: "https://example.com/accepted.png",
    });
    const finalQueued = dispatcher.sendFinalReply({
      text: "Choose the next action.",
      presentation: approvalPresentation,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(blockQueued).toBe(true);
    expect(finalQueued).toBe(true);
    const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
    const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
    expect(block?.finalization).toBeDefined();
    const settledBlock = await block?.finalization;
    expect(settledBlock).toBeDefined();
    expect(settledBlock?.visibleReplySent).toBe(true);
    expect(settledBlock?.messageIds ?? []).toEqual(["om-block-media"]);
    expect(settledBlock?.content ?? "").not.toContain("obsolete streaming paragraph");
    // Core falls back to the original payload text when content is absent.
    expect(settledBlock?.content).toBe("");
    expect(final).toMatchObject({ visibleReplySent: true, messageIds: ["om-final-controls"] });
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledOnce();
    expectNoStaticReply();
    expect(stream(0).discard).toHaveBeenCalledOnce();
  });

  it("retains the original preview receipt and media after failed cleanup", async () => {
    const obsoleteText = "```text\naccepted preview remains visible\n```";
    sendMediaFeishuMock.mockResolvedValue({ messageId: "om-block-media" });
    const { result, dispatcher, deliveries } = createRecordedFeishuDispatcher((kind) => {
      if (kind !== "block") {
        return;
      }
      const instance = stream(0);
      instance.discard.mockImplementationOnce(async () => {
        instance.active = false;
        throw new FeishuStreamingFinalizationError(new Error("preview clear rejected"), {
          visibleReplySent: true,
          content: obsoleteText,
          messageId: "om-original-preview",
        });
      });
    });
    expect(
      dispatcher.sendBlockReply({
        text: obsoleteText,
        mediaUrl: "https://example.com/accepted.png",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: "Choose the next action.",
        presentation: approvalPresentation,
      }),
    ).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
    expect(block?.finalization).toBeDefined();
    await expect(block?.finalization).rejects.toMatchObject(
      partialDelivery(obsoleteText, ["om-original-preview", "om-block-media"]),
    );
    expect(deliveries.some((entry) => entry.kind === "final")).toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    await expect(result.ensureNoVisibleReplyFallback("failed-cleanup")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps an idle-owned close receipt when a later controls card arrives", async () => {
    const text = "```text\naccepted block\n```";
    const closedResult = {
      visibleReplySent: true,
      content: text,
      messageId: "om-closed-before-controls",
    };
    const close = gate<StreamingCloseResult>();
    const card = gate<{ messageId: string }>();
    sendCardFeishuMock.mockImplementationOnce(card.wait);
    const { dispatcher, options, deliveries, entered } = createRecordedFeishuDispatcher((kind) => {
      if (kind !== "block") {
        return;
      }
      const instance = stream(0);
      instance.closeWithResult.mockImplementationOnce(() => {
        // The real session becomes inactive before its awaited close I/O.
        instance.active = false;
        return close.wait();
      });
    });
    try {
      expect(dispatcher.sendBlockReply({ text })).toBe(true);
      await close.started;
      expect(stream(0).closeWithResult).toHaveBeenCalledOnce();
      expect(
        dispatcher.sendFinalReply({
          text: "Choose the next action.",
          presentation: approvalPresentation,
        }),
      ).toBe(true);
      await card.started;
      expect(entered).toHaveBeenCalledWith("final");
      card.resolve({ messageId: "om-later-controls" });
      close.resolve(closedResult);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
      expect(block?.finalization).toBeDefined();
      await expect(block?.finalization).resolves.toMatchObject(
        accepted(text, ["om-closed-before-controls"]),
      );
      expect(final).toMatchObject({ visibleReplySent: true, messageIds: ["om-later-controls"] });
      expect(stream(0).discard).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      card.resolve({ messageId: "om-later-controls" });
      close.resolve(closedResult);
      dispatcher.markComplete();
      await options.onIdle?.();
      await dispatcher.waitForIdle();
    }
  });

  it("retains an idle-owned receipt when matching media registers its completion after close", async () => {
    const text = "```text\naccepted text with later media\n```";
    const closedResult = { visibleReplySent: true, content: text, messageId: "om-closed-stream" };
    const close = gate<StreamingCloseResult>();
    const media = gate<{ messageId: string }>();
    sendMediaFeishuMock.mockImplementation(media.wait);
    const { dispatcher, options, deliveries } = createRecordedFeishuDispatcher((kind) => {
      if (kind !== "block") {
        return;
      }
      const instance = stream(0);
      instance.closeWithResult.mockImplementationOnce(() => {
        instance.active = false;
        return close.wait();
      });
    });
    try {
      expect(dispatcher.sendBlockReply({ text })).toBe(true);
      await close.started;
      expect(stream(0).closeWithResult).toHaveBeenCalledOnce();
      // The preceding delivery has returned. Only idle close overlaps this next
      // serialized delivery; two deliver calls never run concurrently.
      expect(dispatcher.sendFinalReply({ text, mediaUrl: "https://example.com/late.png" })).toBe(
        true,
      );
      await media.started;
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      close.resolve(closedResult);
      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      expect(block?.finalization).toBeDefined();
      await block?.finalization;
      expect(deliveries.filter((entry) => entry.kind === "final")).toHaveLength(0);
      media.resolve({ messageId: "om-late-media" });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
      expect(final?.finalization).toBeDefined();
      await expect(final?.finalization).resolves.toMatchObject(
        accepted(text, ["om-closed-stream", "om-late-media"]),
      );
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(stream(0).discard).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      close.resolve(closedResult);
      media.resolve({ messageId: "om-late-media" });
      dispatcher.markComplete();
      await options.onIdle?.();
      await dispatcher.waitForIdle();
    }
  });

  it("suppresses internal block payload delivery", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });
    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("sends complete chunked blocks to the DM target", async () => {
    useNonStreamingBlockAccount();
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) =>
      text === "First paragraph." ? ["First ", "paragraph."] : [text],
    );
    const mentions = [{ openId: "ou_target", name: "Target User", key: "@_user_1" }];
    const { options } = createDispatcherHarness({
      chatId: "oc_p2p_chat",
      sendTarget: "user:ou_sender",
      replyToMessageId: "om_direct",
      skipReplyToInMessages: true,
      mentionTargets: mentions,
    });
    await options.deliver({ text: "First paragraph." }, { kind: "block" });
    await options.deliver(
      { text: "Second paragraph.", mediaUrl: "https://example.com/block.png" },
      { kind: "block" },
    );
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(3);
    expectSend(sendMessageFeishuMock, { to: "user:ou_sender", text: "First ", mentions });
    expectSend(sendMessageFeishuMock, { text: "paragraph." }, 1);
    expectSend(sendMessageFeishuMock, { text: "Second paragraph." }, 2);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]).not.toHaveProperty("mentions");
    expect(sendMessageFeishuMock.mock.calls[2]?.[0]).not.toHaveProperty("mentions");
    expectSend(sendMediaFeishuMock, {
      to: "user:ou_sender",
      mediaUrl: "https://example.com/block.png",
    });
    expect(streamingInstances).toHaveLength(0);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      agentId: "agent",
      identity: { name: "Agent", emoji: "根据心情/语气自由切换 😊🇺🇸👍🏽👨‍👩‍👧‍👦", theme: "green" as const },
      header: { title: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent", template: "green" },
    },
    { agentId: "main", identity: undefined, header: undefined },
  ])(
    "renders streaming and static identity headers for $agentId",
    async ({ agentId, identity, header }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "feishu"));
      const { options } = createDispatcherHarness({ agentId, identity });
      await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
      await options.onIdle?.();
      expectStreamingStartOptions(0, { header });
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "off", "feishu"));
      const { options: staticOptions } = createDispatcherHarness({ agentId, identity });
      await staticOptions.deliver({ text: "| a | b |\n| - | - |" }, { kind: "final" });
      expectSend(
        sendStructuredCardFeishuMock,
        { header },
        sendStructuredCardFeishuMock.mock.calls.length - 1,
      );
    },
  );

  it.each(["⚠️ Exec failed", "The file is ready.\n\n⚠️ Exec failed"])(
    "retains the answer exactly once before error final %s",
    async (text) => {
      const { options } = createDispatcherHarness();
      await options.deliver({ text: "The file is ready." }, { kind: "final" });
      await options.deliver({ text, isError: true }, { kind: "final" });
      await options.onIdle?.();
      expect(streamingInstances).toHaveLength(1);
      expect(stream(0).closeWithResult).toHaveBeenCalledTimes(1);
      expectClosed("The file is ready.\n\n⚠️ Exec failed");
      expectNoStaticReply();
    },
  );

  it("does not create an empty card when assistant message start has no deliverable final", async () => {
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(0);
    expectNoStaticReply();
  });

  it.each([
    { name: "delta blocks", partials: ["hello"], block: "lo world", expected: "hellolo world" },
    {
      name: "new generation snapshots",
      partials: [
        "Preparing the lookup plan with enough text to count as one block.",
        "Found",
        "Found the answer.",
      ],
      block: undefined,
      expected:
        "Preparing the lookup plan with enough text to count as one block.Found the answer.",
    },
    {
      name: "private reasoning tags",
      partials: ["<thinking>private chain of thought</thinking>\nvisible answer"],
      block: undefined,
      expected: "visible answer",
    },
  ])("streams $name without losing visible content", async ({ partials, block, expected }) => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "feishu"));
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    for (const text of partials) {
      result.replyOptions.onPartialReply?.({ text });
    }
    if (block) {
      await options.deliver({ text: block }, { kind: "block" });
    }
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(1);
    expect(stream(0).closeWithResult).toHaveBeenCalledTimes(1);
    expectClosed(expected);
  });

  it("keeps an over-limit block in its active streaming card", async () => {
    useStreamingBlockAccount();
    const text = makeTableText(6);
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text });
    const delivery = await options.deliver({ text }, { kind: "block" });
    await options.onIdle?.();
    const finalized = await delivery?.finalization;
    expect(streamingInstances).toHaveLength(1);
    expect(stream(0).start).toHaveBeenCalledTimes(1);
    expect(stream(0).closeWithResult).toHaveBeenCalledOnce();
    expectClosed(text);
    expectNoStaticReply();
    expect(finalized).toMatchObject(accepted(text, ["om_stream"]));
  });

  it.each([false, true])(
    "keeps TTS caption visibility when already delivered=%s",
    async (visible) => {
      if (visible) {
        useStreamingBlockAccount();
      } else {
        useNonStreamingAutoAccount();
      }
      const { options } = createDispatcherHarness();
      if (visible) {
        await options.deliver({ text: "Readable answer" }, { kind: "block" });
      }
      await options.deliver(
        {
          ...(visible ? {} : { text: "Readable answer" }),
          mediaUrl: "https://example.com/reply.ogg",
          audioAsVoice: true,
          ttsSupplement: {
            spokenText: "Readable answer",
            ...(visible ? { visibleTextAlreadyDelivered: true } : {}),
          },
        },
        { kind: "final" },
      );
      await options.onIdle?.();
      expectSend(sendMediaFeishuMock, {
        mediaUrl: "https://example.com/reply.ogg",
        audioAsVoice: true,
      });
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      if (visible) {
        expect(streamingInstances).toHaveLength(1);
        expect(stream(0).discard).not.toHaveBeenCalled();
        expectClosed("Readable answer");
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      } else {
        expectSend(sendMessageFeishuMock, { text: "Readable answer" });
        expect(sendMessageFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
          sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
        );
      }
    },
  );

  it("discards partial streaming text when final replies send voice media", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onPartialReply?.({ text: "spoken reply" });
    await options.deliver(
      { text: "spoken reply", mediaUrl: "https://example.com/reply.mp3", audioAsVoice: true },
      { kind: "final" },
    );
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(1);
    expect(stream(0).discard).toHaveBeenCalledTimes(1);
    expect(stream(0).closeWithResult).not.toHaveBeenCalled();
    expectNoStaticReply();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectSend(sendMediaFeishuMock, {
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });
  });

  it("preserves the no-provider-dispatch marker for media preparation failures", async () => {
    useNonStreamingAutoAccount();
    const marker = Object.assign(
      new Error("media load failed", { cause: new Error("blocked local load") }),
      { code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: true },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(marker);
    const { options } = createDispatcherHarness();
    const error = await options
      .deliver({ mediaUrl: "https://files.example.test/image.png" }, { kind: "final" })
      .catch((caught: unknown) => caught);
    expect(error).toBe(marker);
  });

  it("never sends media fallback text after an accepted attachment loses its receipt", async () => {
    useNonStreamingAutoAccount();
    const acceptedError = createChannelPartialDeliveryError(
      new Error("Feishu image send failed: no message_id returned"),
      { messageIds: [], visibleReplySent: true },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(acceptedError);
    const { result, options } = createDispatcherHarness();
    const error = await options
      .deliver(
        {
          text: "caption that must not be duplicated",
          mediaUrl: "https://example.com/reply.mp3",
          audioAsVoice: true,
        },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    await expect(result.ensureNoVisibleReplyFallback("accepted-no-id")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("retains accepted chunk content when a later receipt is lost", async () => {
    useNonStreamingAutoAccount();
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(6);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first", "second", "third"]);
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-first" });
    sendMessageFeishuMock.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("Feishu reply failed: no message_id returned"), {
        messageIds: [],
        visibleReplySent: true,
      }),
    );
    const { options } = createDispatcherHarness();
    const text = "firstsecondthird";
    const error = await options
      .deliver({ text }, { kind: "final" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject(partialDelivery("firstsecond", ["om-first"]));
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
  });

  it.each(["media failure", "idle"])(
    "retains an accepted fallback prefix after %s",
    async (trigger) => {
      getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockReturnValue([
        "first",
        "second",
      ]);
      const media = gate<{ messageId: string }>();
      if (trigger === "media failure") {
        sendMediaFeishuMock.mockImplementationOnce(media.wait);
      }
      sendStructuredCardFeishuMock
        .mockResolvedValueOnce({ messageId: "om-first-static" })
        .mockRejectedValueOnce(new Error("second fallback failed"));
      const { options } = createDispatcherHarness();
      const delivery = options.deliver(
        { text: "firstsecond", ...(trigger === "media failure" ? { mediaUrl: imageUrl } : {}) },
        { kind: "final" },
      );
      if (trigger === "media failure") {
        const error = delivery.catch((caught: unknown) => caught);
        await media.started;
        expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
        stream(0).closeWithResult.mockResolvedValueOnce({
          visibleReplySent: false,
          messageId: "om-empty-stream",
        });
        media.reject(new Error("media failed"));
        await expect(error).resolves.toMatchObject(partialDelivery("first", ["om-first-static"]));
      } else {
        const delivered = await delivery;
        stream(0).closeWithResult.mockResolvedValueOnce({
          visibleReplySent: false,
          messageId: "om-empty-stream",
        });
        await options.onIdle?.();
        await expect(delivered?.finalization).rejects.toMatchObject(
          partialDelivery("first", ["om-first-static"]),
        );
      }
      expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retry degraded-voice fallback as a failed media send", async () => {
    useNonStreamingAutoAccount();
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "om-media",
      voiceIntentDegradedToFile: true,
      receipt: {
        primaryPlatformMessageId: "om-media",
        platformMessageIds: ["om-media"],
        parts: [],
        sentAt: 1,
      },
    });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("fallback text failed"));
    const { options } = createDispatcherHarness();
    const error = await options
      .deliver(
        { text: "voice caption", mediaUrl: "voice.mp3", audioAsVoice: true },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { messageIds: ["om-media"], visibleReplySent: true },
    });
  });

  it("allows recovery after a final rewrite leaves only an earlier preview visible", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onPartialReply?.({ text: "accepted preview" });
    const rejectedDelivery = await options.deliver({ text: "final answer" }, { kind: "final" });
    stream(0).closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("final update failed"), {
        visibleReplySent: true,
        content: "accepted preview",
        messageId: "om-preview",
      }),
    );
    await expect(options.onIdle?.()).rejects.toThrow("final update failed");
    await expect(rejectedDelivery?.finalization).rejects.toMatchObject({
      deliveryResult: accepted("accepted preview", ["om-preview"]),
    });
    const recoveryDelivery = await options.deliver({ text: "final answer" }, { kind: "final" });
    await expect(recoveryDelivery?.finalization).resolves.toMatchObject({
      content: "final answer",
      visibleReplySent: true,
    });
    expect(streamingInstances).toHaveLength(2);
    expectClosed("final answer", 1);
  });

  it.each(["card", "post"] as const)(
    "recovers unaccepted streaming content through a %s",
    async (mode) => {
      const text = mode === "card" ? "accepted final" : makeTableText(6);
      const send = mode === "card" ? sendStructuredCardFeishuMock : sendMessageFeishuMock;
      const messageId = mode === "card" ? "om-static" : "om-post";
      send.mockResolvedValueOnce({ messageId });
      const { options } = createDispatcherHarness();
      const delivery = await options.deliver({ text }, { kind: "final" });
      stream(0).closeWithResult.mockRejectedValueOnce(
        new FeishuStreamingFinalizationError(new Error("final update failed"), {
          visibleReplySent: false,
          messageId: "om-empty-stream",
        }),
      );
      await expect(options.onIdle?.()).rejects.toThrow("final update failed");
      await expect(delivery?.finalization).rejects.toMatchObject(
        partialDelivery(text, [messageId]),
      );
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text }));
      if (mode === "post") {
        expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      }
      await options.deliver({ text }, { kind: "final" });
      await options.onIdle?.();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("retains a failed visible close for media-delayed finalization registration", async () => {
    const media = gate<{ messageId: string }>();
    sendMediaFeishuMock.mockImplementationOnce(media.wait);
    const { options } = createDispatcherHarness();
    const deliveryPromise = options.deliver(
      { text: "accepted card", mediaUrl: imageUrl },
      { kind: "final" },
    );
    await media.started;
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    const instance = stream(0);
    instance.closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("close failed"), {
        visibleReplySent: true,
        content: "accepted card",
        messageId: "om-stream",
      }),
    );
    await expect(options.onIdle?.()).rejects.toThrow("close failed");
    media.resolve({ messageId: "om-media" });
    const delivery = await deliveryPromise;
    await expect(delivery?.finalization).rejects.toMatchObject(
      partialDelivery("accepted card", ["om-stream", "om-media"]),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("waits for an in-flight close before recovering from companion media failure", async () => {
    const media = gate<{ messageId: string }>();
    sendMediaFeishuMock.mockImplementationOnce(media.wait);
    const { options } = createDispatcherHarness();
    const deliveryErrorPromise = options
      .deliver({ text: "accepted card", mediaUrl: imageUrl }, { kind: "final" })
      .catch((error: unknown) => error);
    await media.started;
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    const instance = stream(0);
    const close = gate<StreamingCloseResult>();
    instance.closeWithResult.mockImplementationOnce(close.wait);
    const idle = Promise.resolve(options.onIdle?.());
    await close.started;
    expect(instance.closeWithResult).toHaveBeenCalledTimes(1);
    media.reject(new Error("media failed"));
    await Promise.resolve();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    instance.active = false;
    close.resolve({ visibleReplySent: true, content: "accepted card", messageId: "om-card" });
    await idle;
    await expect(deliveryErrorPromise).resolves.toMatchObject(
      partialDelivery("accepted card", ["om-card"]),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("settles a delivery arriving during an unrelated failed close separately", async () => {
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "first" }, { kind: "final" });
    const instance = stream(0);
    const close = gate<StreamingCloseResult>();
    instance.closeWithResult.mockImplementationOnce(close.wait);
    const idle = Promise.resolve(options.onIdle?.());
    await close.started;
    expect(instance.closeWithResult).toHaveBeenCalledTimes(1);
    const lateDelivery = await options.deliver({ text: "second" }, { kind: "final" });
    close.reject(
      new FeishuStreamingFinalizationError(new Error("close failed"), {
        visibleReplySent: true,
        content: "first",
        messageId: "om-stream",
      }),
    );
    await expect(idle).rejects.toThrow("close failed");
    await expect(firstDelivery?.finalization).rejects.toMatchObject({
      deliveryResult: { content: "first" },
    });
    expect(lateDelivery).toMatchObject({ content: "second", visibleReplySent: true });
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second" }),
    );
  });

  it("preserves and finalizes a replacement streaming session started during close", async () => {
    const core = getFeishuRuntimeMock();
    core.channel.text.resolveTextChunkLimit.mockReturnValue(5);
    core.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) => [text]);
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "one" }, { kind: "final" });
    const firstInstance = stream(0);
    const close = gate<StreamingCloseResult>();
    firstInstance.closeWithResult.mockImplementationOnce(close.wait);
    const idle = Promise.resolve(options.onIdle?.());
    await close.started;
    expect(firstInstance.closeWithResult).toHaveBeenCalledTimes(1);
    firstInstance.active = false;
    await options.deliver({ text: "oversized" }, { kind: "final" });
    const replacementDelivery = await options.deliver({ text: "two" }, { kind: "final" });
    expect(streamingInstances).toHaveLength(2);
    close.resolve({ visibleReplySent: true, content: "one", messageId: "om_stream" });
    await idle;
    await expect(firstDelivery?.finalization).resolves.toMatchObject({ content: "one" });
    await expect(replacementDelivery?.finalization).resolves.toMatchObject({ content: "two" });
    expectClosed("two", 1);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "two" }),
    );
  });

  it("assigns an idle-closed card to its later matching final before media", async () => {
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "accepted answer" });
    await options.onIdle?.();
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om-media" });
    const delivery = await options.deliver(
      { text: "accepted answer", mediaUrl: imageUrl },
      { kind: "final" },
    );
    expect(delivery).toMatchObject(accepted("accepted answer", ["om_stream", "om-media"]));
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps a media-delayed final associated with its own closed streaming session", async () => {
    const media = gate<{ messageId: string }>();
    sendMediaFeishuMock.mockImplementationOnce(media.wait);
    const { result, options } = createDispatcherHarness();
    const firstDeliveryPromise = options.deliver(
      { text: "first", mediaUrl: imageUrl },
      { kind: "final" },
    );
    await media.started;
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    stream(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: true,
      content: "first",
      messageId: "om-first",
    });
    await options.onIdle?.();
    result.replyOptions.onPartialReply?.({ text: "second" });
    expect(streamingInstances).toHaveLength(2);
    const secondInstance = stream(1);
    const secondClose = gate<StreamingCloseResult>();
    secondInstance.closeWithResult.mockImplementationOnce(secondClose.wait);
    const secondDelivery = await options.deliver({ text: "second" }, { kind: "final" });
    await secondClose.started;
    expect(secondInstance.closeWithResult).toHaveBeenCalledTimes(1);
    media.resolve({ messageId: "om-media" });
    const firstDelivery = await firstDeliveryPromise;
    secondInstance.active = false;
    secondClose.resolve({ visibleReplySent: true, content: "second", messageId: "om-second" });
    await expect(secondDelivery?.finalization).resolves.toMatchObject(
      accepted("second", ["om-second"]),
    );
    await expect(firstDelivery?.finalization).resolves.toMatchObject(
      accepted("first", ["om-first", "om-media"]),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("shares one closed streaming settlement with every delayed payload owner", async () => {
    const firstMedia = gate<{ messageId: string }>();
    const secondMedia = gate<{ messageId: string }>();
    sendMediaFeishuMock
      .mockImplementationOnce(firstMedia.wait)
      .mockImplementationOnce(secondMedia.wait);
    const { options } = createDispatcherHarness();
    const firstDeliveryPromise = options.deliver(
      { text: "first", mediaUrl: "https://example.com/first.png" },
      { kind: "final" },
    );
    await firstMedia.started;
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    const secondDeliveryPromise = options.deliver(
      { text: "second", mediaUrl: "https://example.com/second.png" },
      { kind: "final" },
    );
    await secondMedia.started;
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    stream(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: true,
      content: "second",
      messageId: "om-shared",
    });
    await options.onIdle?.();
    firstMedia.resolve({ messageId: "om-media-first" });
    const firstDelivery = await firstDeliveryPromise;
    await expect(firstDelivery?.finalization).resolves.toMatchObject(
      accepted("first", ["om-shared", "om-media-first"]),
    );
    secondMedia.resolve({ messageId: "om-media-second" });
    const secondDelivery = await secondDeliveryPromise;
    await expect(secondDelivery?.finalization).resolves.toMatchObject(
      accepted("second", ["om-shared", "om-media-second"]),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("retains every accepted voice upload fallback when a later fallback fails", async () => {
    sendMediaFeishuMock
      .mockRejectedValueOnce(new Error("first upload failed"))
      .mockRejectedValueOnce(new Error("second upload failed"))
      .mockRejectedValueOnce(new Error("third upload failed"));
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-fallback" })
      .mockResolvedValueOnce({ messageId: "om-second-fallback" })
      .mockRejectedValueOnce(new Error("third fallback failed"));
    const { options } = createDispatcherHarness();
    const error = await options
      .deliver(
        {
          text: "spoken reply",
          mediaUrls: [
            "https://example.com/first.mp3",
            "https://example.com/second.mp3",
            "https://example.com/third.mp3",
          ],
          audioAsVoice: true,
        },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject(
      partialDelivery(
        "spoken reply\n\n📎 https://example.com/first.mp3\n\n📎 https://example.com/second.mp3",
        ["om-first-fallback", "om-second-fallback"],
      ),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(3);
  });

  it("does not leak local media paths in the upload failure fallback", async () => {
    const mediaPath = path.join(os.tmpdir(), "openclaw-feishu-reply-local-voice.mp3");
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));
    const { options } = createDispatcherHarness();
    await options.deliver(
      { text: "spoken reply", mediaUrl: mediaPath, audioAsVoice: true },
      { kind: "final" },
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const fallbackText = String(firstMockArg(sendMessageFeishuMock, "message send params").text);
    expect(fallbackText).toBe("spoken reply\n\nMedia upload failed. Please try again.");
    expect(fallbackText).not.toContain(mediaPath);
  });

  it.each([
    {
      name: "reasoning and answer",
      reasoning: ["thinking step 1", "thinking step 1\nstep 2"],
      partial: "answer part",
      final: "answer part final",
      expected: "> thinking step",
      duplicate: true,
    },
    {
      name: "reasoning only",
      reasoning: ["deep thought"],
      partial: undefined,
      final: undefined,
      expected: "> deep thought",
      duplicate: false,
    },
    {
      name: "empty reasoning",
      reasoning: [""],
      partial: "```ts\ncode\n```",
      final: "```ts\ncode\n```",
      expected: "",
      duplicate: false,
    },
  ])(
    "renders $name in the reasoning-enabled stream",
    async ({ reasoning, partial, final, expected, duplicate }) => {
      const { result, options } = createDispatcherHarness({ allowReasoningPreview: true });
      await options.onReplyStart?.();
      for (const text of reasoning) {
        result.replyOptions.onReasoningStream?.({ text });
      }
      if (partial) {
        result.replyOptions.onPartialReply?.({ text: partial });
      }
      result.replyOptions.onReasoningEnd?.();
      if (final) {
        await options.deliver({ text: final }, { kind: "final" });
      }
      await options.onIdle?.();
      if (duplicate) {
        await options.deliver({ text: final }, { kind: "final" });
      }
      expect(streamingInstances).toHaveLength(1);
      expect(stream(0).closeWithResult).toHaveBeenCalledTimes(1);
      const closed = firstStreamingCloseText();
      if (!expected) {
        expect(closed).not.toContain("Thinking");
        expect(closed).toBe(final);
        return;
      }
      expect(closed).toContain("> 💭 **Thinking**");
      expect(closed).toContain(expected);
      expect(closed).not.toContain("Reasoning:");
      if (!final) {
        expect(closed).not.toContain("---");
        return;
      }
      const updates = streamingUpdateTexts();
      const thinking = updates.find((text) => text.includes("Thinking"));
      expect(thinking).toContain("> 💭 **Thinking**");
      expect(thinking).toContain(expected);
      expect(thinking).not.toContain("Reasoning:");
      expect(thinking).not.toMatch(/> _.*_/);
      expect(updates.some((text) => text.includes("Thinking") && text.includes("---"))).toBe(true);
      expect(closed).toContain("---");
      expect(closed).toContain(final);
    },
  );

  it("omits reasoning callbacks unless reasoning previews are allowed", () => {
    const { result } = createDispatcherHarness();
    expect(result.replyOptions.onReasoningStream).toBeUndefined();
    expect(result.replyOptions.onReasoningEnd).toBeUndefined();
  });

  it("uses streaming cards for thread replies and keeps topic metadata", async () => {
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
    expect(streamingInstances).toHaveLength(1);
    expectStreamingStartOptions(0, {
      replyToMessageId: "om_msg",
      replyInThread: true,
      rootId: "om_root_topic",
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "web_search",
      toolCallId: "search-1",
      phase: "start",
      visible: true,
      label: "Web Search",
    },
    {
      name: "process",
      toolCallId: "poll-1",
      phase: "result",
      isError: false,
      args: { action: "poll" },
      visible: false,
      label: "Process",
    },
  ] as const)(
    "keeps $name progress transient with visibility=$visible",
    async ({ visible, label, ...event }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "feishu"));
      const { result, options } = createDispatcherHarness();
      await options.onReplyStart?.();
      result.replyOptions.onItemEvent?.(projectAgentToolActivity(event));
      result.replyOptions.onPartialReply?.({ text: "final answer" });
      await options.onIdle?.();
      const updates = streamingUpdateTexts().join("\n");
      if (visible) {
        expect(updates).toContain(label);
      } else {
        expect(updates).not.toContain(label);
      }
      expectClosed("final answer");
    },
  );

  it.each([
    { reason: "cancelled_by_reply_payload_sending_hook", recover: false },
    { reason: "channel_transform", recover: false },
    { reason: "adapter_returned_no_identity", recover: true },
  ] as const)("allows recovery=$recover for final outcome $reason", async ({ reason, recover }) => {
    useNonStreamingAutoAccount();
    const { result, options } = createDispatcherHarness();
    const payload = { text: "Intentionally suppressed answer" };
    if (!recover) {
      await options.beforeDeliver?.(payload, { kind: "final" });
    }
    await result.delivery.onDelivered?.(
      payload,
      { kind: "final" },
      { visibleReplySent: false, suppression: { reason } },
    );
    await expect(result.ensureNoVisibleReplyFallback("dispatch-complete")).resolves.toBe(recover);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(recover ? 1 : 0);
  });

  it.each([
    { failureKind: "final", recover: true },
    { failureKind: "block", recover: false },
  ] as const)(
    "preserves recovery=$recover for $failureKind failure after cancellation",
    async ({ failureKind, recover }) => {
      useNonStreamingAutoAccount();
      const { result, options } = createDispatcherHarness();
      const cancelFinal = async () => {
        const payload = { text: "Cancelled final" };
        await options.beforeDeliver?.(payload, { kind: "final" });
        await result.delivery.onDelivered?.(
          payload,
          { kind: "final" },
          { visibleReplySent: false, suppression: { reason: "cancelled_by_message_sending_hook" } },
        );
      };
      const failDelivery = async () => {
        await options.beforeDeliver?.({ text: "Failed answer" }, { kind: failureKind });
        await Promise.resolve(options.onError?.(new Error("send rejected"), { kind: failureKind }));
      };
      await failDelivery();
      await cancelFinal();
      await expect(result.ensureNoVisibleReplyFallback("dispatch-complete")).resolves.toBe(recover);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(recover ? 1 : 0);
    },
  );

  it.each([
    { name: "newer silence", skippedIndex: 2, deliveryIndex: 1, rewritten: false, recover: false },
    {
      name: "unindexed failure",
      skippedIndex: undefined,
      deliveryIndex: undefined,
      rewritten: false,
      recover: true,
    },
    {
      name: "rewritten later block",
      skippedIndex: 1,
      deliveryIndex: 2,
      rewritten: true,
      recover: true,
    },
  ])(
    "preserves fallback ordering after $name",
    async ({ skippedIndex, deliveryIndex, rewritten, recover }) => {
      useNonStreamingBlockAccount();
      const { result, options } = createDispatcherHarness({ sessionKey: "main" });
      options.onSkip?.(
        { text: "NO_REPLY" },
        { kind: "block", reason: "silent", assistantMessageIndex: skippedIndex },
      );
      const payload = { text: rewritten ? "Later visible block" : "Earlier visible block" };
      await options.beforeDeliver?.(payload, {
        kind: "block",
        assistantMessageIndex: deliveryIndex,
      });
      sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));
      await expect(
        options.deliver(rewritten ? { ...payload, text: "Rewritten visible block" } : payload, {
          kind: "block",
        }),
      ).rejects.toThrow("send failed");
      await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(recover);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(recover ? 2 : 1);
      if (rewritten) {
        expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toBe(
          "Rewritten visible block",
        );
      }
      if (recover) {
        expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
          "without visible content",
        );
      }
    },
  );

  it("waits for pending streaming close before no-visible-reply fallback", async () => {
    const { result, options } = createDispatcherHarness();
    const text = "```md\nvisible answer\n```";
    await options.deliver({ text }, { kind: "final" });
    const session = stream(0);
    const close = gate<StreamingCloseResult>();
    session.closeWithResult.mockImplementationOnce(close.wait);
    const idle = options.onIdle?.();
    const fallback = result.ensureNoVisibleReplyFallback("zero-final-count");
    await close.started;
    expect(session.closeWithResult).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    session.active = false;
    close.resolve({ visibleReplySent: true, content: text, messageId: "om_stream" });
    await idle;
    await expect(fallback).resolves.toBe(false);
    expect(session.closeWithResult).toHaveBeenCalledWith(text, { note: "Agent: agent" });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("sends no-visible-reply fallback after an empty card streaming close", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "partial", "feishu"));
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    await options.onIdle?.();
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(true);
    expect(streamingInstances).toHaveLength(1);
    expectClosed("");
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("keeps visible reply state across repeated reply-start keepalives", async () => {
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "block" });
    await options.onReplyStart?.();
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("cleans streaming state even when close throws", async () => {
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "```md\nfirst\n```" }, { kind: "final" });
    const first = stream(0);
    first.closeWithResult.mockImplementationOnce(async () => {
      first.active = false;
      throw new Error("close failed");
    });
    const finalization = expect(firstDelivery?.finalization).rejects.toThrow("close failed");
    await expect(options.onIdle?.()).rejects.toThrow("close failed");
    await finalization;
    await options.deliver({ text: "```md\nsecond\n```" }, { kind: "final" });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(2);
    expectClosed("```md\nsecond\n```", 1);
  });

  it("backs off streaming retries after start() throws (HTTP 400)", async () => {
    const errorMock = vi.fn();
    let shouldFailStart = true;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      const firstInstance = args[0];
      if (shouldFailStart && firstInstance) {
        firstInstance.start = vi
          .fn()
          .mockRejectedValue(new Error("Create card request failed with HTTP 400"));
        shouldFailStart = false;
      }
      return origPush(...args);
    };
    try {
      const { options } = createDispatcherHarness({
        runtime: { log: vi.fn(), error: errorMock } as never,
      });
      await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
      expect(errorMock.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "streaming start failed",
      );
      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);
      await options.deliver({ text: "```ts\nconst y = 2\n```" }, { kind: "final" });
      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
      nowSpy.mockReturnValue(62_000);
      await options.deliver({ text: "```ts\nconst z = 3\n```" }, { kind: "final" });
      await options.onIdle?.();
      expect(streamingInstances).toHaveLength(2);
      expect(stream(1).start).toHaveBeenCalled();
      expect(stream(1).closeWithResult).toHaveBeenCalled();
    } finally {
      streamingInstances.push = origPush;
      nowSpy.mockRestore();
    }
  });

  it("falls back to post mode for 6 tables with explicit renderMode=card", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "off", "feishu"));
    const { options } = createDispatcherHarness();
    await options.deliver({ text: makeTableText(6) }, { kind: "final" });
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
