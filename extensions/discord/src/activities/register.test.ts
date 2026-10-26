import { afterEach, describe, expect, it, vi } from "vitest";
import { getDiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";
import {
  createActivityTestConfig,
  createMemoryKeyedStore,
  createRegisteredActivityFixture,
} from "./test-helpers.test-support.js";

const sendRuntime = vi.hoisted(() => ({ imports: 0 }));
// mock-isolation: Registration must not initialize the optional outbound transport.
vi.mock("../send.components.js", () => {
  sendRuntime.imports += 1;
  return { sendDiscordComponentMessage: vi.fn() };
});

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
    await expect(activity.consumePendingLaunch("default", "channel", "user")).resolves.toEqual(
      replacement,
    );
  });
});

const unconfigured = { channels: { discord: { token: "test" } } };
const context = { messageChannel: "discord", accountId: "default", nativeChannelId: "987654321" };
it.each([true, false])("registers static routes; configured=%s", (configured) => {
  const { route, presenter, resolvePath } = createRegisteredActivityFixture(
    configured ? unconfigured : {},
    undefined,
    configured ? createActivityTestConfig() : unconfigured,
  );
  expect(sendRuntime.imports).toBe(0);
  expect(route).toMatchObject({ path: "/discord/activity", auth: "plugin", match: "prefix" });
  expect(resolvePath).toHaveBeenCalledWith("assets/embedded-app-sdk.mjs");
  expect(presenter).toMatchObject({
    target: "current_channel",
    capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
  });
  expect(presenter.target === "current_channel" && presenter.match(context)).toBe(configured);
  expect(getDiscordActivitiesRuntime()).toBeDefined();
});
