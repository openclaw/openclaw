// Feishu tests cover reply dispatcher block receipts for tables a card cannot draw.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

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
    return {
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  }),
);

function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }
  if (previous.startsWith(next) || previous.includes(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

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
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
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
vi.mock("./streaming-card.js", () => {
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
    FeishuStreamingFinalizationError,
    mergeStreamingText,
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

type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;

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

describe("createFeishuReplyDispatcher block table receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingStartBackoffUntilByAccount.clear();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue(undefined);
    sendStructuredCardFeishuMock.mockReset().mockResolvedValue(undefined);
    sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "om_card" });
    getGlobalHookRunnerMock.mockReturnValue(null);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "partial" },
        httpTimeoutMs: 45_000,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "block"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
          chunkMarkdownTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });
  type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];
  type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;
  type TypingDispatcherOptions = ReplyDispatcherPlan["dispatcherOptions"] &
    ReplyDispatcherPlan["delivery"];
  function createReplyAccount(
    renderMode: "auto" | "card",
    streamingMode: "off" | "partial",
    domain: "feishu" | "lark",
  ) {
    return {
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain,
      config: {
        renderMode,
        streaming: { mode: streamingMode },
      },
    };
  }
  function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      ...overrides,
    });

    return {
      result,
      options: toTypingDispatcherOptions(result),
    };
  }
  function toTypingDispatcherOptions(result: ReplyDispatcherPlan): TypingDispatcherOptions {
    return { ...result.dispatcherOptions, ...result.delivery };
  }
  function requireStreamingInstance(instanceIndex: number): StreamingSessionStub {
    const instance = streamingInstances[instanceIndex];
    if (!instance) {
      throw new Error(`Expected streaming instance ${instanceIndex}`);
    }
    return instance;
  }
  const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
  // GFM makes the outer pipes optional, and a fence hides rows that only look like a table.
  const pipelessTableMarkdown = "Name | Role\n--- | ---\nAda | Lead";

  beforeEach(async () => {
    sendMessageFeishuMock.mockReset();
    const actual = await vi.importActual<
      typeof import("openclaw/plugin-sdk/markdown-table-runtime")
    >("openclaw/plugin-sdk/markdown-table-runtime");
    const runtime = getFeishuRuntimeMock();
    getFeishuRuntimeMock.mockReturnValue({
      ...runtime,
      channel: {
        ...runtime.channel,
        text: {
          ...runtime.channel.text,
          resolveMarkdownTableMode: actual.resolveMarkdownTableMode,
          convertMarkdownTables: actual.convertMarkdownTables,
        },
      },
    });
    // Feishu declares block as its plugin default; the harness registers the
    // same meta because it does not load the runtime setup.
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          source: "test",
          plugin: {
            id: "feishu",
            meta: { id: "feishu" },
            messaging: { defaultMarkdownTableMode: "block" },
          },
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function tableCfg(tables?: MarkdownTableMode): ClawdbotConfig {
    return tables ? { channels: { feishu: { markdown: { tables } } } } : {};
  }

  function createBlockTableHarness(
    cfg: ClawdbotConfig = tableCfg("off"),
    allowReasoningPreview = false,
  ) {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "partial", block: { enabled: true } },
      },
    });
    return createDispatcherHarness({ accountId: "main", cfg, allowReasoningPreview });
  }

  it.each([
    { waiter: "idle", phase: "with reasoning for idle", pending: false },
    { waiter: "idle", phase: "with reasoning for idle", pending: true },
    // Final-first compatibility controls reach the lookup after close clears reasoning.
    { waiter: "final", phase: "after final clears reasoning", pending: false },
    { waiter: "final", phase: "after final clears reasoning", pending: true },
  ])("reuses the off answer receipt $phase and pending=$pending", async ({ waiter, pending }) => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    let acceptPost!: (value: { messageId: string }) => void;
    sendMessageFeishuMock.mockReturnValueOnce(
      new Promise((resolve) => {
        acceptPost = resolve;
      }),
    );
    result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    const block = options.deliver({ text: tableMarkdown }, { kind: "block" });
    await vi.waitFor(() => expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1));
    if (!pending) {
      acceptPost({ messageId: "om-reasoned-answer" });
      await block;
    }
    const idle = waiter === "idle" ? Promise.resolve(options.onIdle?.()) : undefined;
    const final =
      waiter === "final" ? options.deliver({ text: tableMarkdown }, { kind: "final" }) : undefined;
    await vi.waitFor(() => expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1));
    if (pending) {
      acceptPost({ messageId: "om-reasoned-answer" });
    }
    const acceptedBlock = await block;
    await idle;
    const acceptedFinal = final
      ? await final
      : await options.deliver({ text: tableMarkdown }, { kind: "final" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toBe(tableMarkdown);
    expect(acceptedFinal).toMatchObject({
      messageIds: ["om-reasoned-answer"],
      visibleReplySent: true,
    });
    expect(acceptedFinal?.receipt?.parts).toEqual(acceptedBlock?.receipt?.parts);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  // With no accepted block to reuse, the close still delivers reasoning and answer.
  it("preserves reasoning when idle alone posts an off answer", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    result.replyOptions.onReasoningStream?.({ text: "Check the team roster." });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain("> Check the team roster.");
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain(tableMarkdown);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it("reuses the posted block receipt when idle closes its matching off preview", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-block-post" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const block = await options.deliver({ text: tableMarkdown }, { kind: "block" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    expect(final).toMatchObject({
      messageIds: ["om-block-post"],
      visibleReplySent: true,
    });
    expect(final?.receipt?.parts).toEqual(block?.receipt?.parts);
    expect(final?.receipt?.platformMessageIds).toEqual(["om-block-post"]);
    expect(final?.receipt?.sentAt).toBe(block?.receipt?.sentAt);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the block post when its matching off final arrives before idle", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-block-before-final" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.deliver({ text: tableMarkdown }, { kind: "block" });
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(final).toMatchObject({
      messageIds: ["om-block-before-final"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("waits for the matching block post before settling an idle close and final", async () => {
    const { result, options } = createBlockTableHarness();
    let acceptPost!: (value: { messageId: string }) => void;
    sendMessageFeishuMock.mockReturnValueOnce(
      new Promise((resolve) => {
        acceptPost = resolve;
      }),
    );
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const block = options.deliver({ text: tableMarkdown }, { kind: "block" });
    await vi.waitFor(() => expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1));
    const idle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1));
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    acceptPost({ messageId: "om-pending-block" });
    await block;
    await idle;
    const settled = (await final?.finalization) ?? final;

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(settled).toMatchObject({
      messageIds: ["om-pending-block"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it.each([
    { waiter: "final", pending: false, receipt: true },
    { waiter: "idle", pending: false, receipt: true },
    { waiter: "final", pending: true, receipt: true },
    { waiter: "idle", pending: true, receipt: true },
    { waiter: "final", pending: true, receipt: false },
    { waiter: "idle", pending: true, receipt: false },
  ])(
    "retains accepted off block chunks for $waiter with pending=$pending and receipt=$receipt",
    async ({ waiter, pending, receipt }) => {
      const { chunkMarkdownTextWithMode } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/reply-chunking")
      >("openclaw/plugin-sdk/reply-chunking");
      getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
        chunkMarkdownTextWithMode,
      );
      getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(200);
      const { result, options } = createBlockTableHarness();
      const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
      let rejectChunk!: (error: Error) => void;
      sendMessageFeishuMock
        .mockResolvedValueOnce(receipt ? { messageId: "om-accepted-prefix" } : {})
        .mockReturnValueOnce(
          new Promise((_, reject) => {
            rejectChunk = reject;
          }),
        )
        .mockResolvedValue({ messageId: "om-unwanted-retry" });
      result.replyOptions.onPartialReply?.({ text });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

      const block = options.deliver({ text }, { kind: "block" }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2));
      if (!pending) {
        rejectChunk(new Error("later chunk rejected"));
        await block;
      }
      const idle =
        waiter === "idle"
          ? Promise.resolve(options.onIdle?.()).catch((error: unknown) => error)
          : undefined;
      const final =
        waiter === "final"
          ? options.deliver({ text }, { kind: "final" }).catch((error: unknown) => error)
          : undefined;
      await vi.waitFor(() => expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1));
      if (pending) {
        rejectChunk(new Error("later chunk rejected"));
      }
      const blockError: unknown = await block;
      expect(isChannelPartialDeliveryError(blockError)).toBe(true);
      if (!isChannelPartialDeliveryError(blockError)) {
        throw new Error("expected partial block acceptance");
      }
      const prefix = sendMessageFeishuMock.mock.calls[0]?.[0]?.text;
      expect(prefix).toBeTruthy();
      expect(prefix).not.toBe(text);
      expect(blockError.deliveryResult).toMatchObject({
        ...(receipt ? { messageIds: ["om-accepted-prefix"] } : {}),
        visibleReplySent: true,
        content: prefix,
      });

      if (waiter === "idle") {
        expect(await idle).toBeInstanceOf(Error);
      }
      const finalError: unknown = final
        ? await final
        : await options.deliver({ text }, { kind: "final" }).catch((error: unknown) => error);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(isChannelPartialDeliveryError(finalError)).toBe(true);
      if (!isChannelPartialDeliveryError(finalError)) {
        throw new Error("expected retained partial acceptance");
      }
      expect(finalError.deliveryResult).toMatchObject({
        ...(receipt ? { messageIds: ["om-accepted-prefix"] } : {}),
        visibleReplySent: true,
        content: prefix,
      });
      expect(finalError.deliveryResult.receipt?.parts).toEqual(
        blockError.deliveryResult.receipt?.parts,
      );
      await Promise.resolve(options.onIdle?.()).catch(() => undefined);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    },
  );

  it("preserves a single accepted off block without message_id for its matching final", async () => {
    const { sendMessageFeishu } = await vi.importActual<typeof import("./send.js")>("./send.js");
    const { result, options } = createBlockTableHarness();
    resolveFeishuAccountMock.mockReturnValue({
      ...createReplyAccount("auto", "partial", "feishu"),
      configured: true,
    });
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValue({ code: 0, data: { message_id: "om-unwanted-retry" } });
    createFeishuClientMock.mockReturnValue({ im: { message: { create: createMessage } } });
    sendMessageFeishuMock.mockImplementation(sendMessageFeishu);
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const blockError: unknown = await options
      .deliver({ text: tableMarkdown }, { kind: "block" })
      .catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(blockError)).toBe(true);
    expect(blockError).toMatchObject({
      message: expect.stringContaining("Feishu send failed: no message_id returned"),
      deliveryResult: { visibleReplySent: true, content: tableMarkdown },
    });
    if (!isChannelPartialDeliveryError(blockError)) {
      throw new Error("expected acceptance without a message identifier");
    }
    expect(blockError.deliveryResult.messageIds ?? []).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "post",
        content: buildFeishuPostMessageContent({ messageText: tableMarkdown }),
      },
    });

    const finalError: unknown = await options
      .deliver({ text: tableMarkdown }, { kind: "final" })
      .catch((error: unknown) => error);
    expect({
      attempts: createMessage.mock.calls.length,
      partialFailure: isChannelPartialDeliveryError(finalError),
    }).toEqual({ attempts: 1, partialFailure: true });
    expect(finalError).toMatchObject({
      message: expect.stringContaining("Feishu send failed: no message_id returned"),
      deliveryResult: { visibleReplySent: true, content: tableMarkdown },
    });
    if (!isChannelPartialDeliveryError(finalError)) {
      throw new Error("expected the matching final to retain the failed outcome");
    }
    expect(finalError.deliveryResult.messageIds ?? []).toEqual([]);
    await Promise.resolve(options.onIdle?.()).catch(() => undefined);
    await expect(result.ensureNoVisibleReplyFallback("accepted-no-id-block")).resolves.toBe(false);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it("retries a rejected in-flight block when idle is the only remaining delivery", async () => {
    const { result, options } = createBlockTableHarness();
    let rejectPost!: (error: Error) => void;
    sendMessageFeishuMock
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
      )
      .mockResolvedValue({ messageId: "om-idle-retry" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const block = options
      .deliver({ text: tableMarkdown }, { kind: "block" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1));
    const idle = Promise.resolve(options.onIdle?.()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1));
    rejectPost(new Error("pending block unavailable"));

    expect(await block).toBeInstanceOf(Error);
    expect(await idle).toBeUndefined();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    expect(final).toMatchObject({ messageIds: ["om-idle-retry"], visibleReplySent: true });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected in-flight block for its matching final before idle", async () => {
    const { result, options } = createBlockTableHarness();
    let rejectPost!: (error: Error) => void;
    sendMessageFeishuMock
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
      )
      .mockResolvedValue({ messageId: "om-final-retry" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const block = options
      .deliver({ text: tableMarkdown }, { kind: "block" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1));
    const final = options
      .deliver({ text: tableMarkdown }, { kind: "final" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1));
    rejectPost(new Error("pending block unavailable"));

    expect(await block).toBeInstanceOf(Error);
    expect(await final).toMatchObject({ messageIds: ["om-final-retry"], visibleReplySent: true });
    await options.onIdle?.();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
  });

  it("still posts an unmatched table preview after a different block post", async () => {
    const { result, options } = createBlockTableHarness();
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const otherTable = tableMarkdown.replace("Ada", "Grace");
    await options.deliver({ text: otherTable }, { kind: "block" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock.mock.calls.map(([params]) => params.text)).toEqual([
      otherTable,
      tableMarkdown,
    ]);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("retains an accepted block receipt when a later matching block post fails", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-accepted-block" });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    await options.deliver({ text: tableMarkdown }, { kind: "block" });

    sendMessageFeishuMock.mockRejectedValueOnce(new Error("later block unavailable"));
    await expect(options.deliver({ text: tableMarkdown }, { kind: "block" })).rejects.toThrow(
      "later block unavailable",
    );
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    const final = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    expect(final).toMatchObject({
      messageIds: ["om-accepted-block"],
      visibleReplySent: true,
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not count a rejected block post as delivered when idle closes", async () => {
    const { result, options } = createBlockTableHarness();
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("block post unavailable"));
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await expect(options.deliver({ text: tableMarkdown }, { kind: "block" })).rejects.toThrow(
      "block post unavailable",
    );
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toBe(tableMarkdown);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown },
    { shape: "pipeless", text: pipelessTableMarkdown },
  ])("recovers a failed idle post as a post for an off $shape table", async ({ text }) => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg("off"),
    });
    result.replyOptions.onPartialReply?.({ text });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    const instance = requireStreamingInstance(0);
    let release!: (closed: StreamingCloseResult) => void;
    instance.discard.mockReturnValueOnce(
      new Promise<StreamingCloseResult>((resolve) => {
        release = resolve;
      }),
    );
    sendMessageFeishuMock
      .mockRejectedValueOnce(new Error("post unavailable"))
      .mockResolvedValue({ messageId: "om-recovery-post" });
    const idle = Promise.resolve(options.onIdle?.()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(instance.discard).toHaveBeenCalledTimes(1));
    instance.active = false;
    const delivery = await options.deliver({ text }, { kind: "final" });
    const finalization = delivery?.finalization;
    release({ visibleReplySent: false, content: "" });

    expect(await idle).toBeInstanceOf(Error);
    const accepted = await finalization;
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(instance.closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toContain("Ada");
    expect(accepted).toMatchObject({
      messageIds: ["om-recovery-post"],
      visibleReplySent: true,
    });
  });
});
