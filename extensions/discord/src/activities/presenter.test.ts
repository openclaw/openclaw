import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendDiscordComponentMessage } from "../send.components.js";
import { createDiscordSendResult } from "../send.receipt.js";
import { createDiscordWidgetPresenter } from "./presenter.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

vi.mock("../send.components.js", () => ({ sendDiscordComponentMessage: vi.fn() }));

type WidgetPresenter = ReturnType<typeof createDiscordWidgetPresenter>;
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];

const context: WidgetPresenterContext = {
  messageChannel: "discord",
  nativeChannelId: "987654321",
  accountId: "default",
};
const document = { kind: "html" as const, html: "<p>Canonical</p>" };

function matches(presenter: WidgetPresenter, overrides: Partial<WidgetPresenterContext> = {}) {
  return presenter.target === "current_channel" && presenter.match({ ...context, ...overrides });
}

const delivery = createDiscordSendResult({
  result: { id: "1000000000000000001" },
  fallbackChannelId: "987654321",
  kind: "card",
});

let store: ReturnType<typeof createActivityTestRuntime>["store"];
let presenter: WidgetPresenter;
const latestWidget = () => store.latestPostedWidgetForChannel("default", "987654321");
const present = (route = context, title = "Status") =>
  presenter.present({ context: route, document, title });
beforeEach(() => {
  const runtime = createActivityTestRuntime();
  store = runtime.store;
  presenter = createDiscordWidgetPresenter(runtime);
  vi.mocked(sendDiscordComponentMessage).mockReset().mockResolvedValue(delivery);
});
afterEach(() => vi.restoreAllMocks());

it("matches only configured Discord channel routes", async () => {
  expect(presenter.target).toBe("current_channel");
  expect(matches(presenter)).toBe(true);
  expect(matches(presenter, { messageChannel: "slack" })).toBe(false);
  expect(
    matches(presenter, {
      nativeChannelId: undefined,
      deliveryContext: { channel: "discord", to: "discord:user:987654321" },
    }),
  ).toBe(false);

  const unconfigured = createDiscordWidgetPresenter(
    createActivityTestRuntime(createActivityTestConfig({ clientSecret: "" })),
  );
  expect(unconfigured.target).toBe("current_channel");
  expect(matches(unconfigured)).toBe(false);
  await expect(unconfigured.availability(context)).resolves.toMatchObject({
    ok: false,
    error: { code: "unavailable" },
  });

  await expect(present(context, "x".repeat(81))).resolves.toMatchObject({
    ok: false,
    error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
  });
});

it("resolves provider-prefixed current-channel targets", async () => {
  const route = {
    ...context,
    nativeChannelId: undefined,
    currentMessagingTarget: "discord:channel:987654321",
  };

  expect(presenter.target === "current_channel" && presenter.match(route)).toBe(true);
  await expect(present(route)).resolves.toMatchObject({ ok: true });
  expect(sendDiscordComponentMessage).toHaveBeenCalledWith(
    "channel:987654321",
    expect.objectContaining({ text: "Status" }),
    expect.any(Object),
  );
});

it("rolls back only the undelivered widget when component delivery fails", async () => {
  const existingId = await store.createWidget({
    html: "<p>existing</p>",
    title: "Existing",
    channelId: "987654321",
    accountId: "default",
    createdAt: 1,
  });
  await store.markWidgetDelivered(existingId, "1000000000000000000");
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
  const createWidget = vi.spyOn(store, "createWidget");
  vi.spyOn(store, "markWidgetDelivered").mockRejectedValueOnce(new Error("state unavailable"));

  await expect(present()).rejects.toThrow(
    "Discord widget was delivered, but its delivery state could not be saved",
  );
  expect(createWidget).toHaveBeenCalledOnce();
  const widgetId = await createWidget.mock.results[0]!.value;
  await expect(store.lookupWidget(widgetId)).resolves.toHaveProperty("deliveredMessageId", null);
});
