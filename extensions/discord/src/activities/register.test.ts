import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscordActivities } from "./register.js";
import { getDiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";
import { createActivityTestConfig, createMemoryKeyedStore } from "./test-helpers.test-support.js";

afterEach(() => {
  setDiscordActivitiesRuntime(undefined);
});

describe("Discord Activity persistence", () => {
  it("records delivery against the current widget and fails if it disappears", async () => {
    const stores = openDiscordActivityStores(createMemoryKeyedStore);
    const activity = new DiscordActivityStore(stores);
    const widget = {
      html: "<p>widget</p>",
      title: "Before",
      accountId: "default",
      channelId: "channel",
      createdAt: 1,
    };
    const id = await activity.createWidget(widget);
    const compareAndApply = stores.widgets.compareAndApply;
    vi.spyOn(stores.widgets, "compareAndApply").mockImplementationOnce(async (...args) => {
      await stores.widgets.register(id, { ...widget, title: "After" });
      return await compareAndApply(...args);
    });

    await activity.markWidgetDelivered(id, "123");
    await expect(activity.lookupWidget(id)).resolves.toMatchObject({
      title: "After",
      deliveredMessageId: "123",
    });
    await activity.deleteWidget(id);
    await expect(activity.markWidgetDelivered(id, "123")).rejects.toThrow(
      "widget disappeared before delivery was recorded",
    );
    await expect(activity.lookupWidget(id)).resolves.toBeUndefined();
  });

  it("keeps a replacement launch when retirement encounters a conflict", async () => {
    const stores = openDiscordActivityStores(createMemoryKeyedStore);
    const activity = new DiscordActivityStore(stores);
    await activity.recordPendingLaunch({
      accountId: "default",
      channelId: "channel",
      discordUserId: "user",
      widgetId: "widget-a",
      createdAt: 1,
    });
    const replacement = { state: "single" as const, widgetId: "widget-b", createdAt: 2 };
    const compareAndApply = stores.launches.compareAndApply;
    vi.spyOn(stores.launches, "compareAndApply").mockImplementationOnce(async (...args) => {
      await stores.launches.register(args[0], replacement);
      return await compareAndApply(...args);
    });

    await activity.retirePendingLaunch("default", "channel", "user", "widget-a");
    await expect(activity.consumePendingLaunch("default", "channel", "user")).resolves.toEqual({
      state: "single",
      widgetId: "widget-b",
      createdAt: 2,
    });
  });
});

function createApi(
  config: Record<string, unknown>,
  runtimeConfig: Record<string, unknown> = config,
) {
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const widgetPresenters: Array<Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0]> = [];
  const resolvePath = vi.fn((input: string) => `/plugin-root/${input}`);
  const api = {
    config,
    logger: { warn: vi.fn() },
    runtime: {
      state: { openKeyedStoreV2: vi.fn(() => createMemoryKeyedStore()) },
      config: { current: () => runtimeConfig },
    },
    registerHttpRoute: vi.fn((route) => routes.push(route)),
    registerWidgetPresenter: vi.fn((presenter) => widgetPresenters.push(presenter)),
    resolvePath,
  } as unknown as OpenClawPluginApi;
  return { api, routes, widgetPresenters, resolvePath };
}

const unconfigured = { channels: { discord: { token: "test" } } };
const context = { messageChannel: "discord", accountId: "default", nativeChannelId: "987654321" };
it.each([true, false])("registers static routes; configured=%s", (configured) => {
  const test = createApi(
    configured ? unconfigured : {},
    configured ? createActivityTestConfig() : unconfigured,
  );

  registerDiscordActivities(test.api);

  expect(test.routes).toEqual([
    expect.objectContaining({ path: "/discord/activity", auth: "plugin", match: "prefix" }),
  ]);
  expect(test.resolvePath).toHaveBeenCalledWith("assets/embedded-app-sdk.mjs");
  expect(test.widgetPresenters).toEqual([
    expect.objectContaining({
      target: "current_channel",
      capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
    }),
  ]);
  const presenter = test.widgetPresenters[0];
  expect(presenter?.target === "current_channel" && presenter.match(context)).toBe(configured);
  expect(getDiscordActivitiesRuntime()).toBeDefined();
});
