import { describe, expect, it, vi } from "vitest";

const lookupTelegramSentWidget = vi.hoisted(() => vi.fn());
const recordResult = vi.hoisted(() => vi.fn());
// mock-isolation: widget records live in the plugin-state database, which these unit tests do not open.
vi.mock("./widget-store.js", () => ({
  lookupTelegramSentWidget,
  recordTelegramWidgetTap: vi.fn(),
}));
const runtimeConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
// mock-isolation: each test swaps in its own Gateway config snapshot.
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  readRuntimeConfig: () => runtimeConfig.current,
}));
vi.mock("../bot-processing-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bot-processing-outcome.js")>()),
  isTelegramSpooledReplayUpdate: () => true,
  recordTelegramMessageProcessingResult: recordResult,
}));

const { readTelegramWidgetQuery } = await import("./widget-bot-api.js");
const { createTelegramWidgetQueryRouter, createTelegramWidgetRequestGate } =
  await import("./widget-query-router.js");

describe("Telegram widget request gate", () => {
  it("admits a request text once per window per widget", () => {
    let now = 0;
    const admit = createTelegramWidgetRequestGate(() => now);
    expect(admit("1:10", "refresh", "q1")).toBe(true);
    // A widget polling with the same data in the background reaches the agent once.
    now = 5_000;
    expect(admit("1:10", "refresh", "q2")).toBe(false);
    expect(admit("1:10", "vote:2", "q3")).toBe(true);
    expect(admit("1:11", "refresh", "q4")).toBe(true);
    now = 61_000;
    expect(admit("1:10", "refresh", "q5")).toBe(true);
  });

  it("admits a durable replay of an already admitted query", () => {
    const admit = createTelegramWidgetRequestGate(() => 0);
    expect(admit("1:10", "vote:v", "q1")).toBe(true);
    expect(admit("1:10", "vote:v", "q1")).toBe(true);
    expect(admit("1:10", "vote:v", "q2")).toBe(false);
  });

  it("caps distinct requests at ten per minute per widget", () => {
    const admit = createTelegramWidgetRequestGate(() => 0);
    const results = Array.from({ length: 12 }, (_, i) => admit("1:10", `tap:${i}`, `q${i}`));
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe("readTelegramWidgetQuery", () => {
  const query = {
    id: "q1",
    from: { id: 7, is_bot: false, first_name: "A" },
    chat: { id: 7, type: "private", first_name: "A" },
    message_id: 42,
    chat_instance: "1",
    type: { type: "data" },
    data: "inc",
  };

  it("reads an original-message widget query", () => {
    expect(readTelegramWidgetQuery({ update_id: 1, widget_query: query })).toMatchObject({
      id: "q1",
      message_id: 42,
      data: "inc",
    });
  });

  it("ignores inline-message queries without a chat route", () => {
    const { chat: _chat, message_id: _messageId, ...inline } = query;
    expect(
      readTelegramWidgetQuery({ widget_query: { ...inline, inline_message_id: "abc" } }),
    ).toBeUndefined();
  });
});

describe("formatTelegramWidgetRequestText", () => {
  it("names the widget and its current state so the agent keeps the state shape", async () => {
    const { formatTelegramWidgetRequestText } = await import("./widget-query-router.js");
    const text = formatTelegramWidgetRequestText("vote:v", { title: "Poll", state: '{"v":0}' });
    expect(text).toMatch(/^widget_request: vote:v\n/);
    expect(text).toContain('the widget "Poll"');
    expect(text).toContain(JSON.stringify('{"v":0}'));
  });

  it("includes short widget code so a later session can keep the state shape", async () => {
    const { formatTelegramWidgetRequestText } = await import("./widget-query-router.js");
    const source = "<script>draw(JSON.parse(TelegramWidget.chatData).done)</script>";
    expect(formatTelegramWidgetRequestText("done:1", { title: "Today", source })).toContain(
      `Widget code:\n${source}`,
    );
    expect(
      formatTelegramWidgetRequestText("done:1", { title: "Today", source: "x".repeat(9_000) }),
    ).not.toContain("Widget code:");
  });
});

describe("widget query router", () => {
  runtimeConfig.current = { channels: { telegram: { botToken: "123:abc", widgets: true } } };
  const query = {
    id: "q1",
    from: { id: 7, is_bot: false, first_name: "A" },
    chat: { id: 7, type: "private" as const, first_name: "A" },
    message_id: 10,
    data: "vote:v",
  };
  const createRouter = (
    processMessageWithReplyChain: (...args: unknown[]) => Promise<unknown> = vi.fn(),
    authorized = true,
  ) =>
    createTelegramWidgetQueryRouter({
      params: { accountId: "default", runtime: { error: vi.fn() } } as never,
      message: { processMessageWithReplyChain } as never,
      authorization: {
        resolveTelegramEventAuthorizationContext: async () => ({ storeAllowFrom: [] }),
        authorizeTelegramEventSender: async () => authorized,
      } as never,
    });
  const ctx = {
    update: { update_id: 1, widget_query: query },
    me: { id: 1 },
    getFile: vi.fn(),
  } as never;

  it("drops every tap while widgets are disabled for the account", async () => {
    runtimeConfig.current = { channels: { telegram: { botToken: "123:abc" } } };
    lookupTelegramSentWidget.mockClear();
    const process = vi.fn();
    await createRouter(process).route(ctx, vi.fn());
    expect(process).not.toHaveBeenCalled();
    expect(lookupTelegramSentWidget).not.toHaveBeenCalled();
    runtimeConfig.current = { channels: { telegram: { botToken: "123:abc", widgets: true } } };
  });

  it("drops a tap from a sender outside the allowlist before any agent turn", async () => {
    const process = vi.fn();
    lookupTelegramSentWidget.mockResolvedValueOnce(undefined);
    await createRouter(process, false).route(ctx, vi.fn());
    expect(process).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged tap retryable when routing fails before dispatch", async () => {
    recordResult.mockClear();
    lookupTelegramSentWidget.mockRejectedValueOnce(new Error("store busy"));
    await createRouter().route(ctx, vi.fn());
    expect(recordResult).toHaveBeenCalledWith({
      kind: "failed-retryable",
      error: expect.objectContaining({ message: "store busy" }),
    });
  });

  it("records a retryable dispatch outcome for the ingress owner", async () => {
    recordResult.mockClear();
    lookupTelegramSentWidget.mockResolvedValueOnce(undefined);
    const failure = { kind: "failed-retryable", error: new Error("session busy") };
    await createRouter(async () => failure).route(ctx, vi.fn());
    expect(recordResult).toHaveBeenCalledWith(failure);
  });
});
