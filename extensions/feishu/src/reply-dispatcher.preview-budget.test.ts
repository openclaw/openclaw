// Feishu tests cover the streamed preview budget of the reply dispatcher.
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
  updated: ReturnType<typeof Promise.withResolvers<void>>;
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

vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: getFeishuRuntimeMock,
}));
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
vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
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
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: createFeishuClientMock,
}));
vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));
vi.mock("./typing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./typing.js")>()),
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./streaming-card.js")>()),
    FeishuStreamingSession: class {
      active = false;
      credentials: unknown;
      start = vi.fn(async () => {
        this.active = true;
      });
      updated = Promise.withResolvers<void>();
      update = vi.fn(async () => {
        this.updated.resolve();
      });
      closeWithResult = vi.fn<FeishuStreamingSession["closeWithResult"]>(async (text, _options) => {
        this.active = false;
        return createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_stream" }],
          visibleReplySent: Boolean(text?.trim()),
          ...(text?.trim() ? { content: text } : {}),
          kind: "card",
        });
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

import { createFeishuReplyDeliveryResult } from "./reply-delivery-result.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

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

describe("createFeishuReplyDispatcher preview budget", () => {
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
  function streamingUpdateTexts(instanceIndex = 0): string[] {
    return requireStreamingInstance(instanceIndex).update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
  }
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

  // The card carries the reasoning wrapped and set beside the answer, so the preview answers to
  // the same limit the close does, for the body it writes and not for the answer half alone.
  const half = [
    "| name | detail |",
    "| --- | --- |",
    ...Array.from({ length: 20 }, (_entry, index) => `| row${index} | d |`),
    `| wide | ${"w".repeat(100)} |`,
  ].join("\n");

  it.each(["answer", "reasoning"] as const)(
    "includes a later model wait in the projected %s preview budget",
    async (part) => {
      const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "feishu",
        config: { renderMode: "card", streaming: { mode: "partial" } },
      });
      const table = half;
      const wait = "Waiting for the local model to respond";
      expect(convert(table, "code").length + wait.length * 50).toBeGreaterThan(4000);
      expect(table.length * 2 + wait.length * 50).toBeLessThan(4000);
      const { result, options } = createDispatcherHarness({
        cfg: tableCfg("code"),
        allowReasoningPreview: true,
      });
      await options.onReplyStart?.();
      if (part === "answer") {
        result.replyOptions.onPartialReply?.({ text: table });
      } else {
        result.replyOptions.onReasoningStream?.({ text: table });
      }
      await result.replyOptions.onItemEvent?.({
        itemId: "model-wait",
        kind: "model-wait",
        phase: "update",
        progressText: wait.repeat(50),
        suppressDurableProgress: true,
      });
      await result.replyOptions.onItemEvent?.({
        itemId: "model-wait",
        kind: "model-wait",
        phase: "end",
        suppressDurableProgress: true,
      });
      await options.onIdle?.();
      const updates = streamingUpdateTexts();
      expect(updates.some((text) => text.includes("```"))).toBe(true);
      const waiting = updates.find((text) => text.includes(wait));
      expect(waiting).toBeDefined();
      expect(updates.filter((text) => text.length > 4000)).toEqual([]);
      expect(waiting).not.toContain("```");
      if (part === "reasoning") {
        expect(waiting).toContain("| wide |");
      }
      expect(updates.at(-1)).toContain("```");
      expect(updates.at(-1)).not.toContain(wait);
      expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).not.toContain(wait);
    },
  );

  it("stands down for every plain partial that would push projected reasoning past the limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    // Guard the fixture: the projection fits the limit alone and not beside 1,800 characters,
    // while the authored reasoning fits beside 3,000, so only the projection overshoots.
    expect(convert(half, "code").length + 1_800).toBeGreaterThan(4_000);
    expect(half.length * 2 + 3_000).toBeLessThanOrEqual(4_000);

    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: half });
    expect(streamingInstances).toHaveLength(1);
    for (const length of [600, 1_200, 1_800, 2_400, 3_000]) {
      result.replyOptions.onPartialReply?.({ text: "p".repeat(length) });
    }
    await options.onIdle?.();

    const updates = streamingUpdateTexts(0);
    // The partials that fit still preview, and none past the limit does.
    expect(updates.some((text) => text.includes("p".repeat(600)))).toBe(true);
    expect(updates.filter((text) => text.length > 4_000)).toEqual([]);
  });

  // Table conversion and routing read Markdown with HTML off, where a tag line before a sample is
  // plain text and cannot take the fence with it. The delivered reasoning formatter has to read
  // it the same way, or it italicises the markers and the sample is converted or rerouted.
  it.each(
    ["```", "~~~"].flatMap((fence) =>
      (["block", "code", "bullets", "off"] as const).map((tables) => ({ fence, tables })),
    ),
  )("keeps a $fence-fenced table beside HTML tags in delivered $tables reasoning", async (row) => {
    const { options } = createBlockTableHarness(tableCfg(row.tables));
    const sample = `${row.fence}\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n${row.fence}`;
    await options.deliver(
      { text: `<div>\n${sample}\n</div>`, isReasoning: true },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe(
      `Thinking\n\n_<div>_\n${sample}\n_</div>_`,
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  // Only a projection answers to the limit. Text the author wrote long streams the way it
  // always has, beside reasoning that was never converted.
  it("still previews an authored body that is past the limit", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: "r".repeat(2_000) });
    result.replyOptions.onPartialReply?.({ text: "a".repeat(2_500) });
    await options.onIdle?.();

    expect(streamingUpdateTexts(0).some((text) => text.length > 4_000)).toBe(true);
  });

  // The authored reasoning belongs to one reply. A second reply on the same dispatcher starts
  // with none, so its long plain answer is the author's doing and settles on the card.
  it("starts the next reply on the same dispatcher without the last one's authored reasoning", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: half });
    result.replyOptions.onPartialReply?.({ text: "p".repeat(600) });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);

    result.replyOptions.onPartialReply?.({ text: "a".repeat(4_500) });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(2);
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(1).discard).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
