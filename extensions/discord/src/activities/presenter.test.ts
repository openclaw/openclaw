import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendDiscordComponentMessage } from "../send.components.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import { createDiscordWidgetPresenter } from "./presenter.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

vi.mock("../send.components.js", () => ({ sendDiscordComponentMessage: vi.fn() }));

type WidgetPresenter = ReturnType<typeof createDiscordWidgetPresenter>;
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];

function discordContext(overrides: Partial<WidgetPresenterContext> = {}): WidgetPresenterContext {
  return {
    messageChannel: "discord",
    nativeChannelId: "987654321",
    accountId: "default",
    sessionKey: "agent:main:discord",
    ...overrides,
  };
}

const delivery = {
  messageId: "1000000000000000001",
  channelId: "987654321",
  receipt: createDiscordSendReceipt({
    platformMessageIds: ["1000000000000000001"],
    channelId: "987654321",
    kind: "card",
  }),
};

describe("Discord Activity widget presenter", () => {
  let runtime: ReturnType<typeof createActivityTestRuntime>;
  let presenter: WidgetPresenter;
  const latestWidget = () => runtime.store.latestPostedWidgetForChannel("default", "987654321");
  const present = (context = discordContext(), title = "Status") =>
    presenter.present({ context, document: { kind: "html", html: "<p>Canonical</p>" }, title });
  beforeEach(() => {
    runtime = createActivityTestRuntime();
    presenter = createDiscordWidgetPresenter(runtime);
    vi.mocked(sendDiscordComponentMessage).mockReset().mockResolvedValue(delivery);
  });

  afterEach(() => vi.restoreAllMocks());

  it("matches only configured Discord channel routes", async () => {
    expect(presenter.target).toBe("current_channel");
    if (presenter.target !== "current_channel") {
      throw new Error("expected current-channel presenter");
    }
    expect(presenter.match(discordContext())).toBe(true);
    expect(presenter.match(discordContext({ messageChannel: "slack" }))).toBe(false);
    expect(
      presenter.match(
        discordContext({
          nativeChannelId: undefined,
          deliveryContext: { channel: "discord", to: "discord:user:987654321" },
        }),
      ),
    ).toBe(false);

    const unconfigured = createDiscordWidgetPresenter(
      createActivityTestRuntime(createActivityTestConfig({ clientSecret: "" })),
    );
    expect(unconfigured.target).toBe("current_channel");
    expect(unconfigured.target === "current_channel" && unconfigured.match(discordContext())).toBe(
      false,
    );
    await expect(unconfigured.availability(discordContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });

    await expect(present(discordContext(), "x".repeat(81))).resolves.toMatchObject({
      ok: false,
      error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
    });
  });

  it("resolves provider-prefixed current-channel targets", async () => {
    const context = discordContext({
      nativeChannelId: undefined,
      currentMessagingTarget: "discord:channel:987654321",
    });

    expect(presenter.target === "current_channel" && presenter.match(context)).toBe(true);
    await expect(present(context)).resolves.toMatchObject({ ok: true });
    expect(sendDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:987654321",
      expect.objectContaining({ text: "Status" }),
      expect.any(Object),
    );
  });

  it("rolls back only the undelivered widget when component delivery fails", async () => {
    const existingId = await runtime.store.createWidget({
      html: "<p>existing</p>",
      title: "Existing",
      channelId: "987654321",
      accountId: "default",
      createdAt: 1,
    });
    await runtime.store.markWidgetDelivered(existingId, "1000000000000000000");
    const failure = new Error("send failed");
    vi.mocked(sendDiscordComponentMessage).mockRejectedValueOnce(failure);

    await expect(present()).rejects.toBe(failure);
    await expect(latestWidget()).resolves.toMatchObject({
      id: existingId,
      widget: { title: "Existing" },
    });
  });

  it("keeps a delivered widget when later component bookkeeping fails", async () => {
    vi.mocked(sendDiscordComponentMessage).mockImplementationOnce(async (...args) => {
      await args[2].onDeliveryResult?.(delivery);
      throw new Error("component registry failed");
    });

    await expect(present()).resolves.toMatchObject({ ok: true });
    await expect(latestWidget()).resolves.toMatchObject({
      widget: { deliveredMessageId: delivery.messageId },
    });
  });

  it("surfaces delivery-record failures without deleting the delivered widget", async () => {
    const createWidget = vi.spyOn(runtime.store, "createWidget");
    vi.spyOn(runtime.store, "markWidgetDelivered").mockRejectedValueOnce(
      new Error("state unavailable"),
    );

    await expect(present()).rejects.toThrow(
      "Discord widget was delivered, but its delivery state could not be saved",
    );
    expect(createWidget).toHaveBeenCalledOnce();
    const widgetId = await createWidget.mock.results[0].value;
    await expect(runtime.store.lookupWidget(widgetId)).resolves.toMatchObject({
      deliveredMessageId: null,
    });
  });
});
