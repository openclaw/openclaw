// Feishu tests cover reply dispatcher table limits, fences and preview projection.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

describe("createFeishuReplyDispatcher table limits", () => {
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
  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return value as Record<string, unknown>;
  }
  function requireStreamingInstance(instanceIndex: number): StreamingSessionStub {
    const instance = streamingInstances[instanceIndex];
    if (!instance) {
      throw new Error(`Expected streaming instance ${instanceIndex}`);
    }
    return instance;
  }
  function firstStreamingCloseText(instanceIndex = 0): string {
    const close = requireStreamingInstance(instanceIndex).closeWithResult;
    return String(firstMockArg(close, "streaming close"));
  }
  function streamingUpdateTexts(instanceIndex = 0): string[] {
    return requireStreamingInstance(instanceIndex).update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
  }
  function mockArg(
    mock: ReturnType<typeof vi.fn>,
    callIndex: number,
    argIndex: number,
    label: string,
  ) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`missing ${label} call ${callIndex + 1}`);
    }
    return call[argIndex];
  }
  function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string, argIndex = 0) {
    return mockArg(mock, 0, argIndex, label);
  }
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
  const fencedTableSample = "```\n| Name | Role |\n| --- | --- |\n| Ada | Lead |\n```";
  const bulletsCard = "**Ada**\n• Role: Lead";
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

  it("routes an off final with a table to the post path instead of a streaming card", async () => {
    await deliverFinal("off", "partial");

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableMarkdown }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("routes an off final with a pipeless GFM table to the post path", async () => {
    await deliverFinal("off", "partial", pipelessTableMarkdown);

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown },
    { shape: "pipeless", text: pipelessTableMarkdown },
  ])("posts an off block carrying a $shape table under block streaming", async ({ text }) => {
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
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("off") });

    await options.deliver({ text }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps an off block without a table on the streaming card", async () => {
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
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("off") });

    await options.deliver({ text: "plain block" }, { kind: "block" });
    await options.onIdle?.();

    expect(requireStreamingInstance(0).closeWithResult.mock.calls[0]?.[0]).toBe("plain block");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps an off final whose only table is inside a fence on the card path", async () => {
    await deliverFinal("off", "off", fencedTableSample);

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: fencedTableSample }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("discards an open preview when an off final carries a table", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
    const { result, options } = createDispatcherHarness({
      accountId: "main",
      cfg: tableCfg("off"),
    });
    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

    const delivery = await options.deliver({ text: tableMarkdown }, { kind: "final" });
    await options.onIdle?.();
    await delivery?.finalization;

    const instance = requireStreamingInstance(0);
    expect(instance.discard).toHaveBeenCalledTimes(1);
    expect(instance.closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: tableMarkdown }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { shape: "piped", text: tableMarkdown },
    { shape: "pipeless", text: pipelessTableMarkdown },
  ])(
    "posts an idle-closed $shape table preview and assigns it to the matching final in off mode",
    async ({ text }) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg("off"),
      });
      result.replyOptions.onPartialReply?.({ text });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
      const instance = requireStreamingInstance(0);
      let resolveDiscard!: (closed: StreamingCloseResult) => void;
      const discardPromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveDiscard = resolve;
      });
      let resolveClose!: (closed: StreamingCloseResult) => void;
      const closePromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveClose = resolve;
      });
      instance.discard.mockReturnValueOnce(discardPromise);
      instance.closeWithResult.mockReturnValueOnce(closePromise);
      sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-table-post" });
      const idle = Promise.resolve(options.onIdle?.());
      // Hold whichever way the close leaves the card so the final races it.
      await vi.waitFor(() =>
        expect(
          instance.discard.mock.calls.length + instance.closeWithResult.mock.calls.length,
        ).toBe(1),
      );
      instance.active = false;

      const delivery = await options.deliver({ text }, { kind: "final" });
      resolveDiscard({ visibleReplySent: false, content: "" });
      resolveClose({ visibleReplySent: true, content: text, messageId: "om-table-card" });
      await idle;

      expect(instance.closeWithResult).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.text).toContain("Ada");
      await expect(delivery?.finalization).resolves.toMatchObject({
        messageIds: ["om-table-post"],
        visibleReplySent: true,
      });
    },
  );

  it.each(["bullets", "code"] as const)(
    "assigns an idle-closed table preview to its matching final in %s mode",
    async (tables) => {
      resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "partial", "feishu"));
      const { result, options } = createDispatcherHarness({
        accountId: "main",
        cfg: tableCfg(tables),
      });
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
      const instance = requireStreamingInstance(0);
      let resolveClose!: (closed: StreamingCloseResult) => void;
      const closePromise = new Promise<StreamingCloseResult>((resolve) => {
        resolveClose = resolve;
      });
      instance.closeWithResult.mockReturnValueOnce(closePromise);
      const idle = Promise.resolve(options.onIdle?.());
      await vi.waitFor(() => expect(instance.closeWithResult).toHaveBeenCalledTimes(1));
      instance.active = false;
      const committed = String(instance.closeWithResult.mock.calls[0]?.[0]);

      const delivery = await options.deliver({ text: tableMarkdown }, { kind: "final" });
      resolveClose({ visibleReplySent: true, content: committed, messageId: "om-table" });
      await idle;

      expect(committed).not.toBe(tableMarkdown);
      await expect(delivery?.finalization).resolves.toMatchObject({
        messageIds: ["om-table"],
        visibleReplySent: true,
      });
      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  const convertingModes = [
    { tables: "bullets" as const, converted: () => bulletsCard },
    { tables: "code" as const, converted: () => codeText },
  ];

  // Mirrors the dispatcher's reasoning formatter in one place rather than inline at
  // each call site: structure the renderer has to recognize stays plain, prose is
  // italic. Kept here so a change to that rule updates one expectation, not three.
  const reasoningStructureLine = /^\s*(?:```|\||[-*+\u2022]\s|\d+[.)]\s)/u;
  const expectedReasoning = (text: string): string => {
    let insideFence = false;
    return (
      "Thinking\n\n" +
      text
        .split("\n")
        .map((line) => {
          if (/^\s*```/u.test(line)) {
            insideFence = !insideFence;
            return line;
          }
          return insideFence || !line || reasoningStructureLine.test(line) ? line : `_${line}_`;
        })
        .join("\n")
    );
  };

  // The account that sends is the one the resolver picked, which is not always the
  // one the request named. A table mode configured on that account has to apply.
  it("reads the table mode from the account the request resolves to", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
      enabled: true,
    });
    const { result } = createDispatcherHarness({
      accountId: undefined,
      cfg: { channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } } },
    });

    result.replyOptions.onPartialReply?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    const instance = requireStreamingInstance(0);
    await vi.waitFor(() => expect(instance.update).toHaveBeenCalled());

    expect(instance.update.mock.calls.at(-1)?.[0]).toBe(codeText);
  });

  it.each(convertingModes)(
    "projects a $tables table into the card while it is still streaming",
    async ({ tables, converted }) => {
      const { result } = createBlockTableHarness(tableCfg(tables));

      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
      const instance = requireStreamingInstance(0);
      await vi.waitFor(() => expect(instance.update).toHaveBeenCalled());

      expect(instance.update.mock.calls.at(-1)?.[0]).toBe(converted());
    },
  );

  it.each(convertingModes)(
    "keeps one $tables table when a cumulative partial follows a block",
    async ({ tables, converted }) => {
      const { result, options } = createBlockTableHarness(tableCfg(tables));
      const delivery = await options.deliver({ text: tableMarkdown }, { kind: "block" });

      result.replyOptions.onPartialReply?.({
        text: `${tableMarkdown}\n\nInventory complete.`,
      });
      await options.onIdle?.();
      await delivery?.finalization;

      expect(firstStreamingCloseText()).toBe(`${converted()}\n\nInventory complete.`);
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      // Changing the answer representation must not erase reasoning formatting.
      for (const kind of ["block", "final"] as const) {
        const { options: reasoningOptions } = createBlockTableHarness(tableCfg(tables));
        await reasoningOptions.deliver({ text: tableMarkdown, isReasoning: true }, { kind });
        await reasoningOptions.onIdle?.();
        const instance = requireStreamingInstance(kind === "block" ? 1 : 2);
        expect(instance.closeWithResult).toHaveBeenCalledWith(
          expectedReasoning(converted()),
          expect.anything(),
        );
      }
    },
  );

  it.each(convertingModes)(
    "commits one table when a $tables block repeats its streamed preview",
    async ({ tables, converted }) => {
      const { result, options } = createBlockTableHarness(tableCfg(tables));
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      await options.onIdle?.();

      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
      expect(firstStreamingCloseText()).toBe(converted());
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(convertingModes)(
    "still mirrors $tables block text the preview never streamed",
    async ({ tables, converted }) => {
      const { result, options } = createBlockTableHarness(tableCfg(tables));
      result.replyOptions.onPartialReply?.({ text: "Intro line." });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

      await options.deliver({ text: `\n\n${tableMarkdown}` }, { kind: "block" });
      await options.onIdle?.();

      expect(firstStreamingCloseText()).toBe(`Intro line.\n\n${converted()}`);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(convertingModes)(
    "mirrors a $tables block that arrives without any preview",
    async ({ tables, converted }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));

      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      await options.onIdle?.();

      expect(firstStreamingCloseText()).toBe(converted());
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(["block", undefined] as const)(
    "keeps one native table when a %s block repeats its streamed preview",
    async (tables) => {
      const { result, options } = createBlockTableHarness(tableCfg(tables));
      result.replyOptions.onPartialReply?.({ text: tableMarkdown });
      await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));

      await options.deliver({ text: tableMarkdown }, { kind: "block" });
      await options.onIdle?.();

      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
      expect(firstStreamingCloseText()).toBe(tableMarkdown);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  function presentationCardMarkdown(index = 0): string[] {
    const card = requireRecord(presentationCardBodies()[index], "presentation card");
    const body = requireRecord(card.body, "presentation card body");
    const elements = Array.isArray(body.elements) ? body.elements : [];
    return elements
      .filter((element): element is Record<string, unknown> => isRecord(element))
      .filter((element) => element.tag === "markdown")
      .map((element) => String(element.content));
  }

  async function deliverPresentationTable(tables: MarkdownTableMode | undefined) {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg(tables) });
    return await options.deliver(
      { text: tableMarkdown, presentation: approvalPresentation },
      { kind: "final" },
    );
  }

  it.each(convertingModes)(
    "converts all $tables presentation prose and its fallback",
    async ({ tables, converted }) => {
      const { options } = createBlockTableHarness(tableCfg(tables));
      const delivery = await options.deliver(
        {
          text: tableMarkdown,
          presentation: {
            blocks: [
              { type: "text", text: tableMarkdown },
              { type: "context", text: tableMarkdown },
              {
                type: "buttons",
                buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
              },
            ],
          },
        },
        { kind: "final" },
      );

      expect(presentationCardMarkdown()).toEqual([
        converted(),
        converted(),
        // `code` converts the table to a fence, which cannot survive the color tag.
        tables === "code" ? converted() : `<font color='grey'>${converted()}</font>`,
      ]);
      expect(delivery?.content?.split(converted())).toHaveLength(4);
      expect(delivery?.content).not.toContain("| --- |");
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(convertingModes)(
    "converts the table a $tables presentation card carries",
    async ({ tables, converted }) => {
      const delivery = await deliverPresentationTable(tables);

      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      const markdown = presentationCardMarkdown();
      expect(markdown[0]).toBe(converted());
      expect(markdown.join("\n")).not.toContain("| --- |");
      // The card's prose, the fallback the peer keeps and the reported content agree.
      expect(delivery?.content).toContain(converted());
      expect(delivery?.content).not.toContain("| --- |");
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(["block", undefined] as const)(
    "keeps the native table a %s presentation card carries",
    async (tables) => {
      const delivery = await deliverPresentationTable(tables);

      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(presentationCardMarkdown()[0]).toBe(tableMarkdown);
      expect(delivery?.content).toContain(tableMarkdown);
    },
  );

  // off disables table parsing rather than choosing a card-safe shape, so it has no
  // converted form to put in a card. An explicit presentation stays a card whenever it
  // fits the card limits, with or without controls, so the peer sees one card whose
  // markdown element holds the authored pipes.
  it("keeps the authored table on an off presentation card", async () => {
    const delivery = await deliverPresentationTable("off");

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(presentationCardMarkdown()[0]).toBe(tableMarkdown);
    const serialized = JSON.stringify(presentationCardBodies()[0]);
    expect(serialized).toContain("Allow once");
    expect(serialized).toContain("Deny");
    expect(delivery?.content).toContain(tableMarkdown);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  // `code` pads every cell and adds a fence, so an answer that fits the chunk limit as
  // authored can leave it once the preview projects it. The preview carries the
  // projected form, so that is the form the limit asks about: past it, the close sends
  // the answer through the chunked path and an update would spend the generation on a
  // card element the target refuses.
  it("holds the preview back once the projected answer outgrows the chunk limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const fits = tableMarkdown;
    const outgrows = [
      "| name | detail |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `| row${index} | d |`),
      `| wide | ${"w".repeat(220)} |`,
    ].join("\n");
    // Guard the fixture: both fit the limit as authored, and only one projection stays
    // inside it.
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(fits, "code").length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);

    // The same shape either side of the limit, so the empty half below is a decision
    // and not a preview that never ran.
    const fitting = createBlockTableHarness(tableCfg("code"));
    fitting.result.replyOptions.onPartialReply?.({ text: fits });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    await fitting.options.deliver({ text: fits }, { kind: "final" });
    expect(streamingUpdateTexts(0)).toContain(convert(fits, "code"));

    const outgrowing = createBlockTableHarness(tableCfg("code"));
    outgrowing.result.replyOptions.onPartialReply?.({ text: outgrows });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(2));
    await outgrowing.options.deliver({ text: outgrows }, { kind: "final" });
    expect(streamingUpdateTexts(1)).toEqual([]);
  });

  // The payload is rendered before delivery, so the post path receives text that already
  // carries its fences. Asking whether this step produced them answered nothing, and a
  // quoted table then reached separate messages with unmatched markers.
  it("posts a quoted table as authored when the cut cannot carry its fences", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunking.chunkMarkdownTextWithMode,
    );
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: { renderMode: "raw", streaming: { mode: "off" } },
    });
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const text = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    // The case only means anything while the conversion carries quoted markers and needs
    // more than one message to arrive.
    expect(convert(text, "code")).toContain("> ```");
    expect(convert(text, "code").length).toBeGreaterThan(4000);

    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("code") });
    await options.deliver({ text }, { kind: "final" });

    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      // A message opens and closes its own fences or carries none at all.
      expect((post.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(posts.join("")).toContain("row39");
  });

  // A close writes its whole text in one go. The preview stands down once a conversion
  // outgrows the limit the settled answer is held to, and the close has to settle the same
  // way or it writes the projection the preview was refusing.
  it("closes an outgrown projection through a post rather than the card", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = [
      "| name | detail |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `| row${index} | d |`),
      `| wide | ${"w".repeat(220)} |`,
    ].join("\n");
    // Guard the fixture: it fits the limit as authored and its projection does not.
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);

    const { result, options } = createBlockTableHarness(tableCfg("code"));
    result.replyOptions.onPartialReply?.({ text: outgrows });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    await options.onIdle?.();

    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalled();
  });

  // The card carries the reasoning wrapped and set beside the answer, so the limit belongs
  // to that whole body and not to the answer alone. Two conversions that each fit it can
  // still write a card past it, which is the message the preview was already refusing.
  // Only the projection answers to this, so the authored half below still closes on the
  // card: text the author wrote long streams the way it always has.
  it("closes the whole projected body through a post, not the answer half alone", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const half = [
      "| name | detail |",
      "| --- | --- |",
      ...Array.from({ length: 20 }, (_entry, index) => `| row${index} | d |`),
      `| wide | ${"w".repeat(100)} |`,
    ].join("\n");
    // Guard the fixture: each half projects inside the limit and the two together do not,
    // so the close decides on the body it writes rather than on either half.
    expect(convert(half, "code").length).toBeLessThanOrEqual(4000);
    expect(convert(half, "code").length * 2).toBeGreaterThan(4000);

    const projected = createBlockTableHarness(tableCfg("code"), true);
    projected.result.replyOptions.onReasoningStream?.({ text: half });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    projected.result.replyOptions.onPartialReply?.({ text: half });
    await projected.options.onIdle?.();

    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalled();

    sendMessageFeishuMock.mockClear();
    const authoredReasoning = "r".repeat(2_000);
    const authoredAnswer = "a".repeat(2_500);
    // Guard the fixture: nothing here converts, and the combined body is past the limit
    // for reasons the table mode had no hand in.
    expect(convert(authoredReasoning, "code")).toBe(authoredReasoning);
    expect(convert(authoredAnswer, "code")).toBe(authoredAnswer);
    expect(authoredReasoning.length + authoredAnswer.length).toBeGreaterThan(4000);

    const authored = createBlockTableHarness(tableCfg("code"), true);
    authored.result.replyOptions.onReasoningStream?.({ text: authoredReasoning });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(2));
    authored.result.replyOptions.onPartialReply?.({ text: authoredAnswer });
    await authored.options.onIdle?.();

    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(1).discard).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  // Reasoning shares the card with the answer, and its own conversion can outgrow the
  // limit the answer preview answers to. It gives way to the text as authored there.
  it("shows reasoning as authored when its conversion outgrows the chunk limit", async () => {
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const outgrows = [
      "| name | detail |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `| row${index} | d |`),
      `| wide | ${"w".repeat(220)} |`,
    ].join("\n");
    // Guard the fixture: authored inside the limit, projected past it.
    expect(outgrows.length).toBeLessThanOrEqual(4000);
    expect(convert(outgrows, "code").length).toBeGreaterThan(4000);

    const fitting = createBlockTableHarness(tableCfg("code"), true);
    fitting.result.replyOptions.onReasoningStream?.({ text: tableMarkdown });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(1));
    // Reasoning is quoted before it reaches the card, so the fence carries the quote.
    await vi.waitFor(() => expect(streamingUpdateTexts(0).join("")).toContain("> ```"));

    const outgrowing = createBlockTableHarness(tableCfg("code"), true);
    outgrowing.result.replyOptions.onReasoningStream?.({ text: outgrows });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(2));
    await vi.waitFor(() => expect(streamingUpdateTexts(1).length).toBeGreaterThan(0));
    const reasoning = streamingUpdateTexts(1).join("");
    expect(reasoning).toContain("| wide |");
    expect(reasoning).not.toContain("```");
  });

  // The lifecycle records the reported content as what the reader received, so a fallback
  // that sends the authored table has to report the authored table.
  it("reports the text it posted when the conversion gave way to the authored table", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunking.chunkMarkdownTextWithMode,
    );
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: { renderMode: "raw", streaming: { mode: "off" } },
    });
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const text = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    // The case only means anything while the conversion is the thing that cannot be sent.
    expect(convert(text, "code").length).toBeGreaterThan(4000);

    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("code") });
    const accepted = await options.deliver({ text }, { kind: "final" });

    const posts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(posts.join("")).toBe(text);
    expect(accepted?.content).toBe(text);
  });

  // A presentation whose prose outgrows the card envelope, carrying a quoted table whose
  // conversion no cut at this limit can close and reopen.
  function forcedPresentationFallback() {
    const runtimeText = getFeishuRuntimeMock().channel.text;
    runtimeText.resolveTextChunkLimit.mockReturnValue(100);
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
    const prose = Array.from(
      { length: 1000 },
      (_entry, index) => `Line ${index} of the release report.`,
    ).join("\n");
    const quotedTable = [
      "> | name | detail |",
      "> | --- | --- |",
      "> | Ada | Lead |",
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("code") });
    return {
      quotedTable,
      lastProseLine: "Line 999 of the release report.",
      quotedRow: "> | Ada | Lead |",
      deliver: async () =>
        await options.deliver(
          {
            text: "Release summary.",
            presentation: {
              blocks: [
                { type: "text", text: prose },
                { type: "text", text: quotedTable },
              ],
            },
          },
          { kind: "final" },
        ),
    };
  }

  // The refused card leaves the presentation to a post, and the prose that post has to be
  // able to send is the presentation's own. Its blocks are projected before the shared
  // renderer sees them, so the authored form recorded for the cut has to come from the
  // authored presentation rather than from that projection, which already carries fences.
  it("posts the whole presentation when a refused card forces an unconvertible fallback", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunking.chunkMarkdownTextWithMode,
    );
    const convert = getFeishuRuntimeMock().channel.text.convertMarkdownTables;
    const fallback = forcedPresentationFallback();
    // The case only means anything while the conversion carries quoted markers, which a cut
    // at this limit can neither close nor reopen.
    expect(convert(fallback.quotedTable, "code")).toContain("> ```");

    await fallback.deliver();

    // Guard the fixture: the envelope refused the card, so the post owns the whole message.
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const posted = sendMessageFeishuMock.mock.calls
      .map((call) => String(call[0]?.text ?? ""))
      .join("");
    expect(posted).toContain(fallback.lastProseLine);
    expect(posted).toContain(fallback.quotedRow);
    expect(posted).not.toContain("```");
  });

  // The lifecycle records the reported content as what the reader received. A presentation
  // fallback is delivered by the same chunker as any other post, so the content it reports
  // is whatever that chunker accepted, not the converted text the branch asked for.
  it("reports the presentation prose a forced fallback posted", async () => {
    const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
      "openclaw/plugin-sdk/reply-chunking",
    );
    getFeishuRuntimeMock().channel.text.chunkMarkdownTextWithMode.mockImplementation(
      chunking.chunkMarkdownTextWithMode,
    );
    const fallback = forcedPresentationFallback();

    const delivery = await fallback.deliver();

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const posted = sendMessageFeishuMock.mock.calls
      .map((call) => String(call[0]?.text ?? ""))
      .join("");
    expect(posted).toContain(fallback.quotedRow);
    expect(delivery?.content).toContain(fallback.quotedRow);
    expect(delivery?.content).toContain(fallback.lastProseLine);
    expect(delivery?.content).not.toContain("```");
  });

  // The reply path builds the same card, so the mode it resolves has to reach the element
  // renderer there too. off converts nothing, so without it the raw rows read as undrawable
  // and the card would list what the mode asked it to leave alone.
  it("keeps an authored quoted table on an off presentation card", async () => {
    resolveFeishuAccountMock.mockReturnValue(createReplyAccount("auto", "off", "feishu"));
    const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
    const { options } = createDispatcherHarness({ accountId: "main", cfg: tableCfg("off") });

    await options.deliver(
      { presentation: { blocks: [{ type: "text", text: quoted }] } },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(presentationCardMarkdown()).toEqual([
      "&gt; | Name | Role |\n&gt; | --- | --- |\n&gt; | Ada | Lead |",
    ]);
  });
});
