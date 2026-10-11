import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscordActivities } from "./register.js";
import { getDiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";
import { createMemoryKeyedStore } from "./test-helpers.test-support.js";

afterEach(() => {
  setDiscordActivitiesRuntime(undefined);
  vi.unstubAllEnvs();
});

describe("Discord Activity persistence", () => {
  const launch = {
    accountId: "default",
    channelId: "channel",
    discordUserId: "user",
    widgetId: "widget-a",
    createdAt: 1,
  };

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
    await activity.recordPendingLaunch(launch);
    const compareAndApply = stores.launches.compareAndApply;
    vi.spyOn(stores.launches, "compareAndApply").mockImplementationOnce(async (...args) => {
      await stores.launches.register(args[0], {
        state: "single",
        widgetId: "widget-b",
        createdAt: 2,
      });
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
      state: { openKeyedStore: vi.fn(() => createMemoryKeyedStore()) },
      config: { current: () => runtimeConfig },
    },
    registerHttpRoute: vi.fn((route) => routes.push(route)),
    registerWidgetPresenter: vi.fn((presenter) => widgetPresenters.push(presenter)),
    resolvePath,
  } as unknown as OpenClawPluginApi;
  return { api, routes, widgetPresenters, resolvePath };
}

describe("Discord Activities registration", () => {
  it.each(["compareAndApply"] as const)("requires plugin state %s", (method) => {
    const openKeyedStore = <T>() => {
      const store: PluginStateKeyedStore<T> = createMemoryKeyedStore<T>();
      store[method] = undefined;
      return store;
    };

    expect(() => openDiscordActivityStores(openKeyedStore)).toThrow(
      "Discord Activities require atomic plugin state comparisons",
    );
  });

  it("registers static transport surfaces before runtime config is published", () => {
    const runtimeConfig = {
      channels: {
        discord: {
          token: "test",
          activities: { clientSecret: "secret", applicationId: "123" },
        },
      },
    };
    const test = createApi({ channels: { discord: { token: "test" } } }, runtimeConfig);

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
    expect(
      presenter?.target === "current_channel" &&
        presenter.match({
          messageChannel: "discord",
          accountId: "default",
          nativeChannelId: "987654321",
        }),
    ).toBe(true);
    expect(getDiscordActivitiesRuntime()).toBeDefined();
  });

  it.each([
    { layout: "source checkout and bundled dist", asset: "assets/embedded-app-sdk.mjs" },
    { layout: "standalone npm package", asset: "dist/assets/embedded-app-sdk.mjs" },
  ])("serves the generated SDK from the $layout layout", async ({ asset }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-activity-root-"));
    const server = createServer();
    try {
      await fs.mkdir(path.join(root, path.dirname(asset)), { recursive: true });
      await fs.writeFile(path.join(root, asset), "export class DiscordSDK {}\n");
      const config = {
        channels: {
          discord: {
            token: "test",
            activities: { clientSecret: "secret", applicationId: "123" },
          },
        },
      };
      const test = createApi(config);
      test.resolvePath.mockImplementation((input: string) => path.join(root, input));
      registerDiscordActivities(test.api);
      const handler = test.routes[0]!.handler;
      server.on("request", (req, res) => void handler(req, res));
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;

      const vendor = await fetch(
        `http://127.0.0.1:${port}/discord/activity/vendor/embedded-app-sdk.mjs`,
      );

      expect(vendor.status).toBe(200);
      await expect(vendor.text()).resolves.toBe("export class DiscordSDK {}\n");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "Activities are unconfigured",
      config: { channels: { discord: { token: "test" } } },
    },
  ])("keeps the static presenter unavailable when $name", ({ config }) => {
    const test = createApi({}, config);
    registerDiscordActivities(test.api);

    const presenter = test.widgetPresenters[0];
    expect(
      presenter?.target === "current_channel" &&
        presenter.match({
          messageChannel: "discord",
          accountId: "default",
          nativeChannelId: "987654321",
        }),
    ).toBe(false);
  });
});
