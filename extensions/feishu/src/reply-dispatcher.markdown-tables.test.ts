// Feishu tests cover reply dispatcher markdown table modes on every delivery path.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
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

describe("createFeishuReplyDispatcher markdown table modes", () => {
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
  function useNonStreamingAutoAccount() {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
  }
  function makeTableText(count: number): string {
    return Array.from({ length: count }, (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`).join(
      "\n\n",
    );
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
  async function deliverFinal(
    tables: MarkdownTableMode | undefined,
    streaming: "off" | "partial",
    text = tableMarkdown,
  ) {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", streaming, "feishu"));
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg(tables) });
    const delivery = await options.deliver({ text }, { kind: "final" });
    await options.onIdle?.();
    await delivery?.finalization;
  }
  const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
  // GFM makes the outer pipes optional, and a fence hides rows that only look like a table.
  const pipelessTableMarkdown = "Name | Role\n--- | ---\nAda | Lead";
  const nativeTableShapes = [
    { shape: "pipeless", text: pipelessTableMarkdown },
    { shape: "leading-pipe-only", text: "| Name | Role\n| --- | ---\n| Ada | Lead" },
    { shape: "trailing-pipe-only", text: "Name | Role |\n--- | --- |\nAda | Lead |" },
    { shape: "CRLF pipeless", text: pipelessTableMarkdown.replaceAll("\n", "\r\n") },
    { shape: "aligned-delimiter", text: "Name | Role\n:--- | ---:\nAda | Lead" },
  ] as const;
  // Our parser finds a table in these two, but the card renderer does not draw one.
  // It does not descend into a blockquote, and it claims the leading list marker
  // for a list. Either way the rows would leave the message, so they take the post
  // path and arrive as a fenced block instead.
  const undrawableTableShapes = [
    {
      shape: "blockquote",
      text: "> Name | Role\n> --- | ---\n> Ada | Lead",
      posted: "> ```\n> | Name | Role |\n> | ---- | ---- |\n> | Ada  | Lead |\n> ```",
    },
    {
      shape: "list-item",
      text: "- Name | Role\n  --- | ---\n  Ada | Lead",
      posted: "```\n| - Name | Role |\n| ------ | ---- |\n| Ada    | Lead |\n```",
    },
  ] as const;
  const nonTableShapes = [
    { shape: "header wider than delimiter", text: "| Name | Role |\n| --- |\n| Ada | Lead |" },
    { shape: "delimiter wider than header", text: "| Name |\n| --- | --- |\n| Ada | Lead |" },
    { shape: "dashless delimiter", text: "| Name | Role |\n| : | : |\n| Ada | Lead |" },
    {
      shape: "blank line before delimiter",
      text: "| Name | Role |\n\n| --- | --- |\n| Ada | Lead |",
    },
  ] as const;
  const bulletsCard = "**Ada**\n• Role: Lead";
  const bulletsPost = "**Ada**  \n• Role: Lead";
  let codeText = "";

  beforeEach(async () => {
    sendMessageFeishuMock.mockReset();
    const actual = await vi.importActual<
      typeof import("openclaw/plugin-sdk/markdown-table-runtime")
    >("openclaw/plugin-sdk/markdown-table-runtime");
    codeText = actual.convertMarkdownTables(tableMarkdown, "code");
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

  it("off keeps the raw table on the post path", async () => {
    await deliverFinal("off", "off");

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableMarkdown }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("bullets converts on the post path", async () => {
    await deliverFinal("bullets", "off");

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: bulletsPost }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("code rides a static card as a fenced block", async () => {
    await deliverFinal("code", "off");

    expect(codeText.startsWith("```")).toBe(true);
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: codeText }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each(
    nativeTableShapes.flatMap(({ shape, text }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
    ),
  )("$tables promotes a $shape native table to a static card", async ({ tables, text }) => {
    await deliverFinal(tables, "off", text);

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      shape: "blockquote",
      text: "```js\nconst a = 1;\n```\n\n> Name | Role\n> --- | ---\n> Ada | Lead",
      posted:
        "```js\nconst a = 1;\n```\n\n> ```\n> | Name | Role |\n> | ---- | ---- |\n> | Ada  | Lead |\n> ```",
    },
    {
      shape: "list-item",
      text: "```js\nconst a = 1;\n```\n\n- Name | Role\n  --- | ---\n  Ada | Lead",
      posted:
        "```js\nconst a = 1;\n```\n\n```\n| - Name | Role |\n| ------ | ---- |\n| Ada    | Lead |\n```",
    },
  ])(
    "posts a $shape table on a reply even when fenced code would promote it",
    async ({ text, posted }) => {
      // shouldUseCard answers true for the fence, and the reply path still
      // declines the card because the message also holds an ineligible table.
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
      const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("block") });

      const delivery = await options.deliver({ text }, { kind: "final" });
      await options.onIdle?.();
      await delivery?.finalization;

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    },
  );

  it.each(undrawableTableShapes)(
    "posts a $shape table on a reply even when a card was asked for",
    async ({ text, posted }) => {
      // A reply vetoes the card for these shapes whatever renderMode says. The
      // direct send path still honours an explicit card, so the two differ.
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("card", "off", "feishu"));
      const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("block") });

      const delivery = await options.deliver({ text }, { kind: "final" });
      await options.onIdle?.();
      await delivery?.finalization;

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    },
  );

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, posted, tables })),
    ),
  )(
    "$tables posts a $shape table when an open preview closes on idle",
    async ({ tables, text, posted }) => {
      // The close decision is reached only by an actual preview closing, which
      // a final-with-streaming-enabled case never exercises. The preview opens on
      // text a card can draw, because a card drops the rows of these shapes and the
      // partial carrying one is not allowed to reach it.
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg(tables),
      });
      result.replyOptions.onPartialReply?.({ text: "Reading the roster." });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
      // Partials are snapshots of the whole answer, so the table arrives with the line
      // that opened the preview in front of it.
      result.replyOptions.onPartialReply?.({ text: `Reading the roster.\n\n${text}` });

      await options.onIdle?.();

      const instance = requireStreamingInstance(0);
      // Nothing the card would have dropped rows from was ever shown.
      for (const [shown] of instance.update.mock.calls) {
        expect(String(shown)).not.toContain("Ada");
      }
      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(instance.discard).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      // The post carries the whole answer, the line the preview showed included.
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: `Reading the roster.\n\n${posted}` }),
      );
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, posted, tables })),
    ),
  )(
    "$tables posts a $shape table as a fenced block when streaming is on",
    async ({ tables, text, posted }) => {
      await deliverFinal(tables, "partial", text);

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    },
  );

  it.each(
    undrawableTableShapes.flatMap(({ shape, text, posted }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, posted, tables })),
    ),
  )("$tables posts a $shape table as a fenced block", async ({ tables, text, posted }) => {
    await deliverFinal(tables, "off", text);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: posted }));
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each(
    nonTableShapes.flatMap(({ shape, text }) =>
      (["block", undefined] as const).map((tables) => ({ shape, text, tables })),
    ),
  )("$tables posts literal rows with $shape", async ({ tables, text }) => {
    await deliverFinal(tables, "off", text);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    // Posts encode soft line breaks, but retain the literal non-table prose.
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: text.replace(/(?<!\n)\n(?!\n)/g, "  \n") }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each(["block", undefined] as const)(
    "%s opens a preview for a pipeless block without core block streaming",
    async (tables) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
      const { options } = createDispatcherHarness({ cfg: tableCfg(tables), accountId: "main" });

      await options.deliver({ text: pipelessTableMarkdown }, { kind: "block" });

      expect(streamingInstances).toHaveLength(1);
      expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      await options.onIdle?.();
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
        pipelessTableMarkdown,
        expect.any(Object),
      );
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(["block", undefined] as const)(
    "%s keeps the native table on a static card",
    async (tables) => {
      await deliverFinal(tables, "off");

      expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: tableMarkdown }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("commits converted text through the streaming card", async () => {
    await deliverFinal("bullets", "partial");

    expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe(bulletsCard);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("commits the raw table through the streaming card in block mode", async () => {
    await deliverFinal("block", "partial");

    expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe(tableMarkdown);
  });

  function quoteReasoning(text: string): string {
    return `> \u{1f4ad} **Thinking**\n${text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}`;
  }

  // Streamed reasoning shares the card with the answer, so one card must not
  // show a native table beside a converted one.
  it("commits a converted reasoning table through the streaming card", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("code"), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0];
    expect(committed).toContain(quoteReasoning(codeText));
    expect(committed).not.toContain(quoteReasoning(tableMarkdown));
    // The italic line wrapper runs after conversion and would wrap the fence
    // markers too, but formatReasoningPrefix strips those markers again, so the
    // fence reaches the card whole rather than as literal underscored text.
    expect(committed).not.toContain("_```_");
  });

  it("commits a bullets reasoning table through the streaming card", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("bullets"), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0];
    expect(committed).toContain(quoteReasoning(bulletsCard));
    expect(committed).not.toContain(quoteReasoning(tableMarkdown));
  });

  // Underscores inside a fence are literal text, so wrapping every line of a
  // converted code table corrupts the rows and stops the fence being a fence.
  // Prose in the same payload still reads as reasoning.
  it("keeps a delivered reasoning fence intact and leaves its prose italic", async () => {
    const { options } = createBlockTableHarness(tableCfg("code"));
    await options.deliver(
      { text: `Checking the roster.\n\n${tableMarkdown}`, isReasoning: true },
      { kind: "final" },
    );
    await options.onIdle?.();

    const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
    expect(committed).toContain("_Checking the roster._");
    expect(committed).toContain("```");
    expect(committed).not.toContain("_```_");
    expect(committed).toContain("| Ada  | Lead |");
    expect(committed).not.toMatch(/_\| Ada {2}\| Lead \|_/u);
  });

  // A fence is not the only shape the mode produces. `block` leaves a native table
  // and `bullets` emits list markers, and underscoring those lines stops Feishu
  // recognising either one.
  it.each([
    { tables: "block" as const, structural: "| Ada | Lead |", wrapped: "_| Ada | Lead |_" },
    { tables: "bullets" as const, structural: "• Role: Lead", wrapped: "_• Role: Lead_" },
  ])(
    "keeps a delivered $tables reasoning table readable",
    async ({ tables, structural, wrapped }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));
      await options.deliver(
        { text: `Checking the roster.\n\n${tableMarkdown}`, isReasoning: true },
        { kind: "final" },
      );
      await options.onIdle?.();

      const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
      // Prose still reads as reasoning.
      expect(committed).toContain("_Checking the roster._");
      expect(committed).toContain(structural);
      expect(committed).not.toContain(wrapped);
    },
  );

  // A quoted table keeps its prefix through conversion, so the fence and the list
  // marker arrive behind one and a pattern anchored at the line start reads them as
  // prose. Underscoring either stops Feishu recognising the shape the mode produced.
  it.each([
    { tables: "code" as const, structural: "> ```", wrapped: "_> ```_" },
    {
      tables: "bullets" as const,
      structural: "> \u2022 Role: Lead",
      wrapped: "_> \u2022 Role: Lead_",
    },
  ])(
    "keeps a delivered $tables reasoning table readable behind a quote",
    async ({ tables, structural, wrapped }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));
      const quotedTable = tableMarkdown
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      await options.deliver(
        { text: `Checking the roster.\n\n${quotedTable}`, isReasoning: true },
        { kind: "final" },
      );
      await options.onIdle?.();

      const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
      expect(committed).toContain("_Checking the roster._");
      expect(committed).toContain(structural);
      expect(committed).not.toContain(wrapped);
    },
  );

  // `block` leaves every one of these shapes as it found them, so the formatter is
  // the last thing standing between the delimiter row and the card. A row is a row
  // whether or not it opens with a pipe.
  it.each(nativeTableShapes)(
    "keeps a delivered $shape reasoning table readable",
    async ({ text }) => {
      const { options } = createBlockTableHarness(tableCfg("block"));
      await options.deliver({ text: `Checking.\n\n${text}`, isReasoning: true }, { kind: "final" });
      await options.onIdle?.();

      const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
      expect(committed).toContain("_Checking._");
      for (const line of text.split(/\r?\n/u)) {
        expect(committed).toContain(line);
        expect(committed).not.toContain(`_${line}_`);
      }
    },
  );

  // A card cannot draw a blockquoted table, and reasoning is always quoted, so a
  // native table in reasoning used to lose its rows on the card the answer earned.
  it("keeps the card and the reasoning rows when only the reasoning carries a table", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("block"), true);

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: `Checking.\n\n${tableMarkdown}` });
    result.replyOptions.onPartialReply?.({ text: "Inventory complete." });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    await options.onIdle?.();

    const instance = requireStreamingInstance(0);
    // The card is kept: the close commits rather than discarding for a post.
    expect(instance.closeWithResult).toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    const committed = instance.closeWithResult.mock.calls[0]?.[0] ?? "";
    // The rows are still there, as a list the card can draw.
    expect(committed).toContain("Ada");
    expect(committed).toContain("Lead");
    expect(committed).not.toContain("| --- |");
    expect(committed).toContain("Inventory complete.");
  });

  // A card carries a table as one component and the card chunker does not repeat the
  // header, so every card after the first would show raw pipes. An automatic reply asks
  // the same question the outbound send path does, including for the pipe-less shape
  // this branch taught the promotion to recognise.
  it.each([
    { shape: "piped", row: "| r%d | Lead |", head: ["| Name | Role |", "| --- | --- |"] },
    { shape: "pipe-less", row: "r%d | Lead", head: ["Name | Role", "--- | ---"] },
  ])(
    "posts an oversized $shape final rather than splitting it across cards",
    async ({ row, head }) => {
      const { chunkMarkdownTextWithMode } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/reply-chunking")
      >("openclaw/plugin-sdk/reply-chunking");
      getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
        chunkMarkdownTextWithMode,
      );
      getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(200);
      const { options } = createBlockTableHarness(tableCfg("block"));
      const table = [
        ...head,
        ...Array.from({ length: 40 }, (_entry, i) => row.replace("%d", String(i))),
      ].join("\n");
      // Guard the fixture: one card could not hold it.
      expect(table.length).toBeGreaterThan(200);

      await options.deliver({ text: table }, { kind: "final" });

      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text)).join("");
      // The post path renders it as a fenced block, so the header survives every cut.
      expect(posted).toContain("```");
      expect(posted).toContain("Name");
      expect(posted).toContain("r39");
    },
  );

  // The shared fence scanner reads no quote prefix, so a converted blockquoted table
  // cannot be closed and reopened at a cut and its two markers land in different
  // messages. The reply post path asks the same question the outbound one does.
  it("posts a quoted reply table as authored when its fence would not survive the cut", async () => {
    const { chunkMarkdownTextWithMode } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/reply-chunking")
    >("openclaw/plugin-sdk/reply-chunking");
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunkMarkdownTextWithMode,
    );
    getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(200);
    const { options } = createBlockTableHarness(tableCfg("block"));
    const quoted = [
      "Roster",
      "",
      ...[
        "| Name | Role |",
        "| --- | --- |",
        ...Array.from({ length: 12 }, (_entry, i) => `| r${i} | Lead |`),
      ].map((line) => `> ${line}`),
    ].join("\n");

    await options.deliver({ text: quoted }, { kind: "final" });

    const posted = sendMessageFeishuMock.mock.calls.map(([call]) => String(call.text));
    expect(posted.length).toBeGreaterThan(1);
    // No message opens a block another has to close.
    for (const message of posted) {
      expect((message.match(/^>?\s*```/gmu) ?? []).length % 2).toBe(0);
    }
    // The chunker already decided; the sender must not convert a second time and
    // rebuild the table this guard just declined.
    for (const [call] of sendMessageFeishuMock.mock.calls) {
      expect(call.preparedPostText).toBe(true);
    }
    const joined = posted.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("r11");
  });

  // Reasoning is blockquoted before it reaches the card, and a card drops the rows of a
  // quoted table, so the preview used to lose them for as long as it ran. This asserts
  // the drawable form the close path already commits, not the pipes behind it.
  it("shows a streamed block reasoning table as rows the preview can draw", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("block"), true);

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: `Checking.\n\n${tableMarkdown}` });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    const instance = requireStreamingInstance(0);
    await vi.waitFor(() => expect(instance.update).toHaveBeenCalled());

    const shown = String(instance.update.mock.calls.at(-1)?.[0] ?? "");
    expect(shown).toContain("Ada");
    expect(shown).toContain("Lead");
    expect(shown).not.toContain("| Ada | Lead |");
    expect(shown).not.toContain("| --- |");
  });

  // A matching block that already failed partially rethrows instead of replaying its
  // accepted chunks. The attachment on the final is an independent send, so that
  // rejection must not cancel it.
  it("still delivers final media after a partly rejected matching block", async () => {
    const { chunkMarkdownTextWithMode } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/reply-chunking")
    >("openclaw/plugin-sdk/reply-chunking");
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunkMarkdownTextWithMode,
    );
    getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(200);
    const { options } = createBlockTableHarness(tableCfg("off"));
    const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-accepted-prefix" })
      .mockRejectedValueOnce(new Error("later chunk rejected"))
      .mockResolvedValue({ messageId: "om-later" });
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om-media" });

    const blockError: unknown = await options
      .deliver({ text }, { kind: "block" })
      .catch((error: unknown) => error);
    expect(blockError).toBeInstanceOf(Error);

    const finalError: unknown = await options
      .deliver({ text, mediaUrl: "https://example.com/report.png" }, { kind: "final" })
      .catch((error: unknown) => error);

    // The attachment is attempted even though the text settlement is a rejection.
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    // The rejection still reaches the caller rather than being swallowed.
    expect(finalError).toBeInstanceOf(Error);
    // And it reports what was accepted, not what was asked for. Handing the merge the
    // whole reply as an authoritative override would report the rejected suffix as
    // delivered, which is the shape the shared lifecycle then records.
    const reported = isChannelPartialDeliveryError(finalError)
      ? finalError.deliveryResult
      : undefined;
    expect(reported?.content).toBeDefined();
    expect(reported?.content).not.toBe(text);
    expect(text.startsWith(reported?.content ?? "")).toBe(true);
  });

  // An idle close with no prior block delivery owns nothing in the block receipt map,
  // so a partly accepted close post used to leave the matching final free to send the
  // whole answer again, including the prefix the provider had already taken.
  it.each([
    { acceptance: "partial", accepted: true },
    { acceptance: "none", accepted: false },
  ])(
    "handles a late final after an idle close post with $acceptance acceptance",
    async ({ accepted }) => {
      const { chunkMarkdownTextWithMode } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/reply-chunking")
      >("openclaw/plugin-sdk/reply-chunking");
      getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
        chunkMarkdownTextWithMode,
      );
      getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(200);
      const { result, options } = createBlockTableHarness(tableCfg("off"));
      const text = `${tableMarkdown}\n${"| Grace | Engineer |\n".repeat(30)}`.trim();
      if (accepted) {
        sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-accepted-prefix" });
      } else {
        sendMessageFeishuMock.mockRejectedValueOnce(new Error("first chunk rejected"));
      }
      sendMessageFeishuMock
        .mockRejectedValueOnce(new Error("later chunk rejected"))
        .mockResolvedValue({ messageId: "om-later-send" });
      result.replyOptions.onPartialReply?.({ text });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

      const idleError: unknown = await Promise.resolve(options.onIdle?.()).catch(
        (error: unknown) => error,
      );
      const callsAfterIdle = sendMessageFeishuMock.mock.calls.length;

      const lateError: unknown = await options
        .deliver({ text }, { kind: "final" })
        .catch((error: unknown) => error);

      if (accepted) {
        // The prefix the provider took stays taken. The final claims that settlement and
        // reports the original partial failure rather than sending the answer again.
        expect(isChannelPartialDeliveryError(idleError)).toBe(true);
        expect(sendMessageFeishuMock.mock.calls.length).toBe(callsAfterIdle);
        expect(isChannelPartialDeliveryError(lateError)).toBe(true);
      } else {
        // Nothing was accepted, so the answer is still owed and the final retries it.
        expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(callsAfterIdle);
      }
    },
  );

  // This post stands in for the final and the final is then skipped as a duplicate,
  // so the mentions the final would have carried have to ride the post. Otherwise a
  // group reply forwarding mentioned users delivers the answer without notifying them.
  it("forwards mentions when an idle close posts a table", async () => {
    const mentions = [{ openId: "ou_target", name: "Target User", key: "@_user_1" }];
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
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg("off"),
      mentionTargets: mentions,
    });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]).toMatchObject({ mentions });
  });

  // off has no card representation at all, so a reasoning-only table still diverts
  // the whole close to a post rather than being converted.
  it("posts an off close whose only table is in streamed reasoning", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("off"), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain(quoteReasoning(tableMarkdown));
  });

  // The preview gives way to the authored table when its own conversion outgrows the limit,
  // and that authored table is what the close then finds stored. A card blockquotes what it
  // is handed and Feishu draws no rows from a quoted table, so the close has to ask the same
  // projection question the preview asked, in every mode and not only the native one.
  it("re-projects a reasoning table the preview left authored when the close commits", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = [
      "| name | detail |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `| row${index} | d |`),
      `| wide | ${"w".repeat(220)} |`,
    ].join("\n");
    // Guard the fixture: authored inside the limit, so nothing but the projection decides,
    // and the answer carries no table of its own, so this is the reasoning-only case.
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);
    const answer = "Here is the summary.";
    expect(convert(answer, "code")).toBe(answer);

    const harness = createBlockTableHarness(tableCfg("code"), true);
    harness.result.replyOptions.onReasoningStream?.({ text: outgrows });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    harness.result.replyOptions.onPartialReply?.({ text: answer });
    await harness.options.onIdle?.();

    const closed = requireStreamingInstance(0);
    const cardBodies = closed.closeWithResult.mock.calls.map((call) => call[0] ?? "");
    // Counts rather than two walls of rows: the defect is a card that carries any raw row.
    expect(cardBodies.filter((body) => body.includes("| row0 |")).length).toBe(0);
    expect([closed.closeWithResult.mock.calls.length, closed.discard.mock.calls.length]).toEqual([
      0, 1,
    ]);
    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.length).toBeGreaterThan(0);
    // The rows reach the reader in the post, and the configured mode is not swapped for the
    // native one's list on the way.
    expect(posts.join("")).toContain("| row0 |");
    expect(posts.join("")).not.toContain("\u2022");
  });

  // block keeps native tables, and the reasoning half must not diverge from it.
  // This used to assert the quoted native table reached the card, which is the shape
  // a card cannot draw, so what it pinned was the rows disappearing. The card now
  // receives a list instead, which it draws, and the native table is what the post
  // path still carries.
  it("lists a native reasoning table on the streaming card in block mode", async () => {
    const { result, options } = createBlockTableHarness(tableCfg("block"), true);
    result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    result.replyOptions.onPartialReply?.({ text: "Roster ready." });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    await options.onIdle?.();

    const committed = requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0] ?? "";
    expect(committed).not.toContain(quoteReasoning(tableMarkdown));
    expect(committed).toContain("Ada");
    expect(committed).toContain("Lead");
    expect(committed).not.toContain("| --- |");
  });

  describe("table-limit routing", () => {
    function setupDispatcher() {
      const result = createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        chatId: "oc_chat",
        sendTarget: "oc_chat",
      });
      return toTypingDispatcherOptions(result);
    }

    it("routes 5 markdown tables to static card when streaming is off", async () => {
      useNonStreamingAutoAccount();
      const options = setupDispatcher();
      const text = makeTableText(5);
      await options.deliver({ text }, { kind: "final" });

      expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text }));
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });

    it("falls back to post mode for 6 markdown tables when streaming is off", async () => {
      useNonStreamingAutoAccount();
      const options = setupDispatcher();
      const text = makeTableText(6);
      await options.deliver({ text }, { kind: "final" });

      expect(sendMessageFeishuMock).toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });

    it("falls back to post mode for 6 tables with explicit renderMode=card", async () => {
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "feishu",
        config: { renderMode: "card", streaming: { mode: "off" } },
      });
      const options = setupDispatcher();
      const text = makeTableText(6);
      await options.deliver({ text }, { kind: "final" });

      expect(sendMessageFeishuMock).toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    });
  });

  it("resolves the markdown table mode for the named account on post replies", async () => {
    const { convertMarkdownTables, resolveMarkdownTableMode } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/markdown-table-runtime")
    >("openclaw/plugin-sdk/markdown-table-runtime");
    const runtime = getFeishuRuntimeMock();
    getFeishuRuntimeMock.mockReturnValue({
      ...runtime,
      channel: {
        ...runtime.channel,
        text: {
          ...runtime.channel.text,
          resolveMarkdownTableMode,
          convertMarkdownTables,
        },
      },
    });
    // The real resolver answers with the account it selected, so a request naming
    // `work` resolves to `work`. Mocking a fixed id instead would describe a state
    // `resolveFeishuAccount` cannot produce.
    resolveFeishuAccountMock.mockImplementation((params?: { accountId?: string }) => ({
      ...createReplyAccount("auto", "off", "feishu"),
      accountId: params?.accountId ?? "work",
      config: { renderMode: "raw", streaming: { mode: "off" } },
    }));
    const accountTableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          markdown: { tables: "bullets" },
          accounts: { work: { markdown: { tables: "off" } }, other: {} },
        },
      },
    };

    // The shared resolver reads config only for a registered channel id, and this
    // harness does not load the runtime setup, so register a minimal feishu plugin.
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "feishu", source: "test", plugin: { id: "feishu", meta: { id: "feishu" } } },
      ]),
    );
    try {
      // `work` overrides the mode, `other` does not and falls to the channel value.
      for (const accountId of ["work", "other"]) {
        const { result } = createDispatcherHarness({ accountId, cfg });
        const dispatcher = createReplyDispatcher(toTypingDispatcherOptions(result));
        dispatcher.sendFinalReply({ text: accountTableMarkdown });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    } finally {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
    }

    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toBe(accountTableMarkdown);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.text).toBe("**Ada**  \n• Role: Lead");
  });
});
