import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const telegramInboundInfo = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: telegramInboundInfo,
    }),
  }),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

const mockPluginStatus = vi.hoisted(() => vi.fn(() => "🧩 **MCP Plugins** (mock)"));
const MOCK_MCP_COMMANDS = new Set(["/mcp_status", "/mcp_plugins", "/plugin_status"]);
const mockIsPluginCommand = vi.hoisted(() =>
  vi.fn((text: string) => {
    const firstToken = text.trim().split(/\s+/)[0] ?? "";
    const normalized = firstToken.replace(/@\w+$/, "").toLowerCase();
    return MOCK_MCP_COMMANDS.has(normalized);
  }),
);

vi.mock("./plugin-status-message.js", () => ({
  buildTelegramPluginStatusMessage: mockPluginStatus,
  isPluginCommand: mockIsPluginCommand,
  escapeMarkdown: (s: string) => s,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;
let formatTelegramInboundLogLine: typeof import("./bot-message.js").formatTelegramInboundLogLine;
let selectTelegramMcpServersFromText: typeof import("./bot-message.js").selectTelegramMcpServersFromText;
let TELEGRAM_MCP_PLUGIN_MANIFESTS: typeof import("./mcp-plugin-manifest.js").TELEGRAM_MCP_PLUGIN_MANIFESTS;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({
      createTelegramMessageProcessor,
      formatTelegramInboundLogLine,
      selectTelegramMcpServersFromText,
    } = await import("./bot-message.js"));
    ({ TELEGRAM_MCP_PLUGIN_MANIFESTS } = await import("./mcp-plugin-manifest.js"));
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
    telegramInboundInfo.mockClear();
    upsertChannelPairingRequest.mockClear();
  });

  const telegramDepsForTest = {
    upsertChannelPairingRequest,
  } as unknown as TelegramBotDeps;

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    telegramDeps: telegramDepsForTest,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    lifecycle?: import("./bot-message.js").TelegramMessageProcessorLifecycle,
    text?: string,
  ) {
    return await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
          ...(text === undefined ? {} : { text }),
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
      undefined,
      undefined,
      undefined,
      lifecycle,
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError };
  }

  function createMessageContext(context: Record<string, unknown> = {}) {
    return {
      chatId: 123,
      ctxPayload: {
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        RawBody: "hello there",
      },
      primaryCtx: { me: { username: "openclaw_bot" } },
      route: { sessionKey: "agent:main:main" },
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    };
  }

  it.each([
    ["안녕", []],
    ["지금 상태 짧게 말해줘", []],
    ["검색해줘", []],
    ["뉴스 찾아봐", []],
    ["github 상태 확인", ["github"]],
    ["gmail 최근 메일", ["gmail"]],
    ["노션 확인", ["notion"]],
    ["문서 확인", []],
    ["문서 OCR 해줘", ["kordoc"]],
    ["tavily 심층검색", ["tavily"]],
    ["sqlite db 조회", ["sqlite"]],
    ["kordoc OCR", ["kordoc"]],
    ["n8n workflow 상태", ["n8n-mcp"]],
    ["github랑 gmail 상태", ["github", "gmail"]],
    ["mcp 전체", ["*"]],
    ["tools", ["*"]],
  ])("selects Telegram MCP servers for %s", (text, expected) => {
    expect(selectTelegramMcpServersFromText(text)).toEqual(expected);
  });

  it("keeps Telegram MCP plugin manifests non-default and triggerable only by manifest text", () => {
    expect(TELEGRAM_MCP_PLUGIN_MANIFESTS).toHaveLength(7);
    for (const manifest of TELEGRAM_MCP_PLUGIN_MANIFESTS) {
      expect(manifest.id).not.toBe("");
      expect(manifest.serverName).not.toBe("");
      expect(manifest.enabledByDefault).toBe(false);
      expect(manifest.telegramDefault).toBe(false);
      expect(manifest.autoCall).toBe(false);
      expect(manifest.triggers.length).toBeGreaterThan(0);
    }
    expect(selectTelegramMcpServersFromText("일반 대화입니다")).toEqual([]);
  });

  it("returns plugin status directly without dispatching", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/mcp_status")).resolves.toBe(
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(123, "🧩 **MCP Plugins** (mock)", {
      parse_mode: "MarkdownV2",
    });
  });

  it("/mcp_status does not dispatch agent run", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/mcp_status")).resolves.toBe(
      true,
    );

    expect(buildTelegramMessageContext).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("/mcp_status does not trigger MCP server selection", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/mcp_status")).resolves.toBe(
      true,
    );

    // Only sendMessage called; no MCP-related or dispatch activity
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(buildTelegramMessageContext).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("/mcp_plugins behaves the same as /mcp_status", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/mcp_plugins")).resolves.toBe(
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(123, "🧩 **MCP Plugins** (mock)", {
      parse_mode: "MarkdownV2",
    });
    expect(buildTelegramMessageContext).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("/mcp_status@botname also returns early", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(
      processSampleMessage(processMessage, undefined, "/mcp_status@jinhee_openclaw_bot"),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(123, "🧩 **MCP Plugins** (mock)", {
      parse_mode: "MarkdownV2",
    });
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("/plugins does NOT trigger MCP early return", async () => {
    // /plugins should reach normal dispatch, not the MCP status route
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ sendTyping }));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/plugins")).resolves.toBe(true);

    // /plugins should dispatch normally (not early-return), but if config says
    // plugins=false it falls through; in this test setup, it reaches dispatch
    expect(dispatchTelegramMessage).toHaveBeenCalled();
  });

  it("/plugin_status behaves the same as /mcp_status", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    await expect(processSampleMessage(processMessage, undefined, "/plugin_status")).resolves.toBe(
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(123, "🧩 **MCP Plugins** (mock)", {
      parse_mode: "MarkdownV2",
    });
    expect(buildTelegramMessageContext).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("dispatches when context is available", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ selectedMcpServers: [] }),
    );
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
    expect(telegramInboundInfo).toHaveBeenCalledWith(
      "Inbound message telegram:123 -> @openclaw_bot (direct, 11 chars)",
    );
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      onDispatchStart.mock.invocationCallOrder[0],
    );
    expect(onDispatchStart.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(false);

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not send early typing cues for room events", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
        ctxPayload: {
          From: "telegram:123",
          To: "telegram:123",
          ChatType: "group",
          RawBody: "ambient",
          InboundEventKind: "room_event",
        },
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(false);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
    expect(telegramInboundInfo).not.toHaveBeenCalled();
  });

  it("formats Telegram inbound summaries without message content", () => {
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:123",
        to: "@openclaw_bot",
        chatType: "direct",
        body: "secret message",
      }),
    ).toBe("Inbound message telegram:123 -> @openclaw_bot (direct, 14 chars)");
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:group:-100",
        to: "@openclaw_bot",
        chatType: "group",
        body: "<media:image>",
        mediaType: "image/jpeg",
      }),
    ).toBe("Inbound message telegram:group:-100 -> @openclaw_bot (group, image/jpeg, 13 chars)");
  });

  it("passes selected MCP servers into dispatch params", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processSampleMessage(processMessage, undefined, "github랑 gmail 상태"),
    ).resolves.toBe(true);

    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ selectedMcpServers: ["github", "gmail"] }),
    );
  });

  it("keeps dispatch running when the early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("omits message_thread_id for General-topic fallback replies", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 1, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
  });

  it("swallows fallback delivery failures after dispatch throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });
});
