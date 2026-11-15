import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramWidget = vi.hoisted(() => vi.fn());
const editTelegramWidgetState = vi.hoisted(() => vi.fn());
const lookupTelegramWidgetTap = vi.hoisted(() => vi.fn());
const lookupTelegramSentWidget = vi.hoisted(() => vi.fn());
const checkTelegramWidget = vi.hoisted(() => vi.fn());

vi.mock("./widget-send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./widget-send.js")>()),
  sendTelegramWidget,
  editTelegramWidgetState,
}));
vi.mock("./widget-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./widget-check.js")>()),
  checkTelegramWidget,
}));
// mock-isolation: widget records live in the plugin-state database, which these unit tests do not open.
vi.mock("./widget-store.js", () => ({
  lookupTelegramWidgetTap,
  lookupTelegramSentWidget,
  recordTelegramSentWidget: vi.fn(),
}));

const { hashTelegramWidgetSource } = await import("./widget-send.js");
const { registerTelegramWidgetPresenter } = await import("./widget-presenter.js");

type Presenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];

let config: Record<string, unknown> = {};
const widgetsConfig = (widgets?: boolean) => ({
  channels: {
    telegram: { enabled: true, botToken: "123:abc", ...(widgets === undefined ? {} : { widgets }) },
  },
});

function registerPresenter(): Presenter {
  let presenter: Presenter | undefined;
  const api = {
    runtime: {
      config: {
        current: () => config,
      },
    },
    registerWidgetPresenter: (registered: Presenter) => {
      presenter = registered;
    },
  } as unknown as OpenClawPluginApi;
  registerTelegramWidgetPresenter(api);
  if (!presenter) {
    throw new Error("presenter was not registered");
  }
  return presenter;
}

const dm = { messageChannel: "telegram", currentChannelId: "telegram:111" };
const SOURCE = "<p id=n></p><script>TelegramWidget.request('x')</script>";

describe("Telegram widget presenter", () => {
  beforeEach(() => {
    config = widgetsConfig(true);
    vi.clearAllMocks();
    sendTelegramWidget.mockResolvedValue({ messageId: "77", chatId: "111" });
    lookupTelegramWidgetTap.mockResolvedValue(undefined);
    checkTelegramWidget.mockResolvedValue({ errors: [], warnings: [] });
  });

  it("returns the trial run's problems to the model instead of sending", async () => {
    checkTelegramWidget.mockResolvedValue({
      errors: ["ReferenceError: s is not defined (script 1, line 8)"],
      warnings: [],
    });
    const presenter = registerPresenter();
    const result = await presenter.present({
      document: { kind: "html", html: "", source: SOURCE },
      title: "Timer",
      name: "timer",
      context: dm,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("- ReferenceError: s is not defined") },
    });
    expect(checkTelegramWidget).toHaveBeenCalledWith({ source: SOURCE, state: null, tapAll: true });
    expect(sendTelegramWidget).not.toHaveBeenCalled();
  });

  it("replays the tapped widget's code and passes approximate findings as notes", async () => {
    lookupTelegramWidgetTap.mockResolvedValue({ chatId: "111", messageId: 42 });
    lookupTelegramSentWidget.mockResolvedValue({
      name: "vote",
      sourceHash: hashTelegramWidgetSource(SOURCE),
      title: "Vote",
      state: '{"v":0}',
      source: SOURCE,
    });
    checkTelegramWidget.mockResolvedValue({
      errors: [],
      warnings: ['The widget shows "undefined" after the state update'],
    });
    const presenter = registerPresenter();
    const result = await presenter.present({
      document: { kind: "html", html: "", source: "" },
      title: "Vote",
      name: "vote",
      state: '{"vote":"v"}',
      context: { ...dm, currentMessageId: "query-1" },
    });
    // Approximate findings never block: the update goes out and the model gets a note.
    expect(result).toMatchObject({
      ok: true,
      value: { updated: true, notes: [expect.stringContaining('shows "undefined"')] },
    });
    expect(checkTelegramWidget).toHaveBeenCalledWith({
      source: SOURCE,
      state: '{"v":0}',
      nextState: '{"vote":"v"}',
      tapAll: false,
    });
    expect(editTelegramWidgetState).toHaveBeenCalled();
  });

  it("checks a cleared state as null, like Telegram, but still sends the empty state", async () => {
    lookupTelegramWidgetTap.mockResolvedValue({ chatId: "111", messageId: 42 });
    lookupTelegramSentWidget.mockResolvedValue({
      name: "vote",
      sourceHash: hashTelegramWidgetSource(SOURCE),
      title: "Vote",
      state: '{"v":0}',
      source: SOURCE,
    });
    const presenter = registerPresenter();
    await presenter.present({
      document: { kind: "html", html: "", source: "" },
      title: "Vote",
      name: "vote",
      state: "",
      context: { ...dm, currentMessageId: "query-1" },
    });
    expect(checkTelegramWidget).toHaveBeenCalledWith(
      expect.objectContaining({ state: '{"v":0}', nextState: null }),
    );
    expect(editTelegramWidgetState).toHaveBeenCalledWith(expect.objectContaining({ state: "" }));
  });

  it("matches private chats and their forum topics only with widgets enabled", () => {
    const match = (context: Parameters<Presenter["availability"]>[0]) =>
      registerPresenter().match?.(context);
    expect(match(dm)).toBe(true);
    expect(match({ ...dm, currentChannelId: "telegram:-100123" })).toBe(false);
    expect(match({ ...dm, messageChannel: "discord" })).toBe(false);
    expect(match({ ...dm, currentMessagingTarget: "telegram:111:topic:77" })).toBe(true);
    expect(match({ ...dm, deliveryContext: { threadId: "77" } })).toBe(true);
    expect(match({ ...dm, currentMessagingTarget: "telegram:111:direct-topic:77" })).toBe(false);
    expect(match({ ...dm, deliveryContext: { threadId: "invalid" } })).toBe(false);
    expect(match({ ...dm, deliveryContext: { threadId: "9007199254740992" } })).toBe(false);
    expect(
      match({
        ...dm,
        currentMessagingTarget: "telegram:111:topic:77",
        deliveryContext: { threadId: "88" },
      }),
    ).toBe(false);
    config = widgetsConfig();
    expect(match(dm)).toBe(false);
    config = widgetsConfig(false);
    expect(match(dm)).toBe(false);
  });

  it.each([
    { ...dm, currentMessagingTarget: "telegram:111:topic:77" },
    { ...dm, deliveryContext: { threadId: "77" } },
  ])("delivers a private-topic widget to the current thread", async (context) => {
    const result = await registerPresenter().present({
      document: { kind: "html", html: "", source: SOURCE },
      title: "Vote",
      name: "vote",
      context,
    });
    expect(result).toMatchObject({ ok: true });
    expect(sendTelegramWidget).toHaveBeenCalledWith(
      expect.objectContaining({ to: "111:topic:77" }),
    );
  });

  it("sends raw widget code as a new message outside a tap turn", async () => {
    const presenter = registerPresenter();
    const result = await presenter.present({
      document: { kind: "html", html: "<wrapped>", source: SOURCE },
      title: "Vote",
      name: "vote",
      state: '{"n":1}',
      context: { ...dm, currentMessageId: "5001" },
    });
    expect(result).toMatchObject({ ok: true, value: { kind: "message" } });
    expect(sendTelegramWidget).toHaveBeenCalledWith(
      expect.objectContaining({ source: SOURCE, title: "Vote", name: "vote", state: '{"n":1}' }),
    );
    expect(editTelegramWidgetState).not.toHaveBeenCalled();
  });

  it("updates the tapped widget in place when its code is unchanged, whatever name the model uses", async () => {
    lookupTelegramWidgetTap.mockResolvedValue({ chatId: "111", messageId: 42 });
    lookupTelegramSentWidget.mockResolvedValue({
      name: "vote",
      sourceHash: hashTelegramWidgetSource(SOURCE),
      title: "Vote",
    });
    const presenter = registerPresenter();
    for (const source of ["", SOURCE]) {
      const result = await presenter.present({
        document: { kind: "html", html: "", source },
        title: "Vote",
        name: "renamed-by-model",
        state: '{"n":2}',
        context: { ...dm, currentMessageId: "query-1" },
      });
      expect(result).toMatchObject({ ok: true, value: { updated: true } });
    }
    expect(editTelegramWidgetState).toHaveBeenCalledTimes(2);
    expect(editTelegramWidgetState).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "111", messageId: 42, state: '{"n":2}' }),
    );
    expect(sendTelegramWidget).not.toHaveBeenCalled();
  });

  it("sends changed code as a new message even in a tap turn", async () => {
    lookupTelegramWidgetTap.mockResolvedValue({ chatId: "111", messageId: 42 });
    lookupTelegramSentWidget.mockResolvedValue({
      name: "vote",
      sourceHash: "other",
      title: "Vote",
    });
    const presenter = registerPresenter();
    await presenter.present({
      document: { kind: "html", html: "", source: SOURCE },
      title: "Vote",
      name: "vote",
      context: { ...dm, currentMessageId: "query-1" },
    });
    expect(sendTelegramWidget).toHaveBeenCalledOnce();
    expect(editTelegramWidgetState).not.toHaveBeenCalled();
  });

  it("refuses a state-only update outside a tap turn", async () => {
    const presenter = registerPresenter();
    const result = await presenter.present({
      document: { kind: "html", html: "", source: "" },
      title: "Vote",
      name: "vote",
      state: "{}",
      context: dm,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "presentation_error" } });
    expect(sendTelegramWidget).not.toHaveBeenCalled();
  });

  it("reports Telegram's compressed size limit before sending", async () => {
    const presenter = registerPresenter();
    const random = Array.from({ length: 6000 }, (_, i) => ((i * 7919) % 9973).toString(36)).join(
      "",
    );
    const result = await presenter.present({
      document: { kind: "html", html: "", source: `<p>${random}</p>` },
      title: "Big",
      name: "big",
      context: dm,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "presentation_error", message: expect.stringMatching(/compressed/) },
    });
    expect(sendTelegramWidget).not.toHaveBeenCalled();
  });
});
