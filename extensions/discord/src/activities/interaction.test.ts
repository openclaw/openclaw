import { InteractionResponseType } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as loggingCore from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseComponentInteraction } from "../internal/discord.js";
import { createInteraction } from "../internal/interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { createDiscordSendResult } from "../send.receipt.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { createDiscordActivityButton } from "./interaction.js";
import { setDiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
  createMemoryKeyedStore,
  createRegisteredActivityFixture,
} from "./test-helpers.test-support.js";

const sendRuntime = vi.hoisted(() => ({
  imports: 0,
  send: vi.fn<typeof import("../send.components.js").sendDiscordComponentMessage>(),
}));
// mock-isolation: Activity tests need only the send boundary, whose import registration defers.
vi.mock("../send.components.js", () => {
  sendRuntime.imports += 1;
  return { sendDiscordComponentMessage: sendRuntime.send };
});
const startupSendImports = sendRuntime.imports;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setDiscordActivitiesRuntime(undefined);
});

const widgetId = "AAAAAAAAAAAAAAAAAAAAAA";
const applicationId = "123456789012345678";

function componentContext(cfg = createActivityTestConfig()): AgentComponentContext {
  return {
    cfg,
    accountId: "default",
    discordConfig: cfg.channels?.discord,
    allowFrom: ["42"],
    dmPolicy: "allowlist",
  };
}

function createLaunchFixture(userId = "42") {
  const runtime = createActivityTestRuntime();
  setDiscordActivitiesRuntime(runtime);
  const button = createDiscordActivityButton(componentContext(), applicationId)!;
  const launchActivity = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  const interaction = {
    launchActivity,
    reply,
    rawData: { channel_id: "777" },
    userId,
  } as unknown as BaseComponentInteraction;
  const run = () => button.run(interaction, { widgetId });
  return { runtime, button, launchActivity, reply, interaction, run };
}

describe("Discord Activity interaction", () => {
  it("learns the startup application ID before resolving Activity availability", () => {
    const cfg = createActivityTestConfig({ applicationId: "" });
    const runtime = createActivityTestRuntime(cfg);
    setDiscordActivitiesRuntime(runtime);
    const context = componentContext(cfg);
    expect(createDiscordActivityButton(context)).toBeNull();
    expect(createDiscordActivityButton(context, applicationId)).not.toBeNull();
    expect(runtime.resolveHttpAccount()?.applicationId).toBe(applicationId);
    const disabledDiscordConfig = { ...context.discordConfig, enabled: false };
    const disabledCfg = { ...cfg, channels: { ...cfg.channels, discord: disabledDiscordConfig } };
    expect(createDiscordActivityButton(componentContext(disabledCfg), applicationId)).toBeNull();
  });

  it("posts a raw LAUNCH_ACTIVITY callback", async () => {
    const client = createInternalTestClient();
    const { post } = attachRestMock(client, {});
    const interaction = createInteraction(
      client,
      createInternalComponentInteractionPayload({ id: "interaction-1", token: "itoken" }),
    ) as BaseComponentInteraction;
    await interaction.launchActivity();
    expect(post).toHaveBeenCalledWith("/interactions/interaction-1/itoken/callback", {
      body: { type: InteractionResponseType.LaunchActivity },
    });
  });

  it("records before launching outside the allowlist and clears its watchdog", async () => {
    const { runtime, button, launchActivity, reply, interaction } = createLaunchFixture("99");
    vi.useFakeTimers();
    const recordPendingLaunch = vi.spyOn(runtime.store, "recordPendingLaunch");
    const action = { type: "web-app", widgetId } as const;
    const rendered = buildDiscordPresentationComponents({
      blocks: [{ type: "buttons", buttons: [{ label: "Open widget", action }] }],
    });
    const actionBlock = rendered?.blocks?.find((block) => block.type === "actions");
    const customId =
      actionBlock?.type === "actions" ? actionBlock.buttons?.[0]?.internalCustomId : "";
    await button.run(interaction, button.customIdParser(customId ?? "").data ?? {});
    expect(reply).not.toHaveBeenCalled();
    const pending = runtime.store.consumePendingLaunch("default", "777", "99");
    await expect(pending).resolves.toMatchObject({ widgetId });
    expect(recordPendingLaunch.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      launchActivity.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(275);
    expect(launchActivity).toHaveBeenCalledOnce();
  });

  it("launches after the write budget when the store stalls and logs once", async () => {
    const logError = vi.spyOn(loggingCore, "logError").mockImplementation(() => {});
    const { runtime, launchActivity, run } = createLaunchFixture();
    const pendingWrite = createDeferred<void>();
    const backgroundSettled = vi.fn<() => void>();
    const stalledWrite = pendingWrite.promise.then(backgroundSettled);
    vi.spyOn(runtime.store, "recordPendingLaunch").mockReturnValue(stalledWrite);
    const startedAt = performance.now();
    try {
      await run();
      expect(launchActivity).toHaveBeenCalledOnce();
      expect(String(logError.mock.calls[0]?.[0])).toContain("exceeded");
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(240);
      expect(backgroundSettled).not.toHaveBeenCalled();
    } finally {
      pendingWrite.resolve();
      await stalledWrite;
    }
    expect(backgroundSettled).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("still launches when recording the pending launch fails and logs once", async () => {
    const logError = vi.spyOn(loggingCore, "logError").mockImplementation(() => {});
    const { runtime, launchActivity, run } = createLaunchFixture();
    vi.spyOn(runtime.store, "recordPendingLaunch").mockRejectedValue(new Error("store offline"));
    await run();
    await run();
    expect(launchActivity).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
  });

  it("replies ephemerally and does not launch for invalid widget data", async () => {
    const { button, launchActivity, reply, interaction } = createLaunchFixture();
    const parsed = button.customIdParser("other:key=value");
    expect(parsed.key).toBe("other");
    await button.run(interaction, parsed.data ?? {});
    expect(reply).toHaveBeenCalledWith({
      content: "This widget is no longer valid.",
      ephemeral: true,
    });
    expect(launchActivity).not.toHaveBeenCalled();
  });
});

type WidgetPresenter = ReturnType<typeof createRegisteredActivityFixture>["presenter"];
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];

const context: WidgetPresenterContext = {
  messageChannel: "discord",
  nativeChannelId: "987654321",
  accountId: "default",
};
const document = { kind: "html" as const, html: "<p>Canonical</p>" };
const storedWidget = {
  html: document.html,
  title: "Existing",
  accountId: context.accountId!,
  channelId: context.nativeChannelId!,
  createdAt: 1,
};

const matches = (presenter: WidgetPresenter, overrides: Partial<WidgetPresenterContext> = {}) =>
  presenter.target === "current_channel" && presenter.match({ ...context, ...overrides });

const delivery = createDiscordSendResult({
  result: { id: "1000000000000000001" },
  fallbackChannelId: "987654321",
  kind: "card",
});

describe("Discord Activity presenter", () => {
  let store: ReturnType<typeof createRegisteredActivityFixture>["runtime"]["store"];
  let presenter: WidgetPresenter;
  const latestWidget = () => store.latestPostedWidgetForChannel("default", "987654321");
  const present = (route = context, title = "Status") =>
    presenter.present({ context: route, document, title });
  beforeEach(() => {
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    ({
      runtime: { store },
      presenter,
    } = createRegisteredActivityFixture());
    sendRuntime.send.mockReset().mockResolvedValue(delivery);
  });

  it.each([
    [{ messageChannel: "slack" }, false],
    [
      {
        nativeChannelId: undefined,
        deliveryContext: { channel: "discord", to: "discord:user:987654321" },
      },
      false,
    ],
    [{ nativeChannelId: undefined, currentMessagingTarget: "discord:channel:987654321" }, true],
  ] as const)("matches and delivers channel route %j", async (overrides, available) => {
    expect(matches(presenter, overrides)).toBe(available);
    if (available) {
      await expect(present({ ...context, ...overrides })).resolves.toMatchObject({ ok: true });
      expect(sendRuntime.send).toHaveBeenCalledWith(
        "channel:987654321",
        expect.objectContaining({ text: "Status" }),
        expect.any(Object),
      );
    }
  });

  it("rejects oversized titles", async () => {
    await expect(present(context, "x".repeat(81))).resolves.toMatchObject({
      ok: false,
      error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
    });
  });

  it("rolls back only the undelivered widget when component delivery fails", async () => {
    const existingId = await store.createWidget(storedWidget);
    await store.markWidgetDelivered(existingId, "1000000000000000000");
    const failure = new Error("send failed");
    sendRuntime.send.mockRejectedValueOnce(failure);
    await expect(present()).rejects.toBe(failure);
    await expect(latestWidget()).resolves.toMatchObject({
      id: existingId,
      widget: { title: "Existing" },
    });
  });

  it("keeps a delivered widget when later component bookkeeping fails", async () => {
    sendRuntime.send.mockImplementationOnce(async (...args) => {
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
    const deliveredWidgetId = await createWidget.mock.results[0]!.value;
    await expect(store.lookupWidget(deliveredWidgetId)).resolves.toHaveProperty(
      "deliveredMessageId",
      null,
    );
  });
});

describe("Discord Activity persistence", () => {
  it("records delivery against the current widget and fails if it disappears", async () => {
    const stores = openDiscordActivityStores(createMemoryKeyedStore);
    const activity = new DiscordActivityStore(stores);
    const id = await activity.createWidget(storedWidget);
    const compareAndApply = stores.widgets.compareAndApply;
    vi.spyOn(stores.widgets, "compareAndApply").mockImplementationOnce(async (...args) => {
      await stores.widgets.register(id, { ...storedWidget, title: "After" });
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

it.each([true, false])("registers static routes; configured=%s", async (configured) => {
  const importsBeforeRegistration = sendRuntime.imports;
  const { route, presenter, resolvePath } = createRegisteredActivityFixture(
    {},
    undefined,
    configured ? createActivityTestConfig() : {},
  );
  expect(startupSendImports).toBe(0);
  expect(sendRuntime.imports).toBe(importsBeforeRegistration);
  expect(route).toMatchObject({ path: "/discord/activity", auth: "plugin", match: "prefix" });
  expect(resolvePath).toHaveBeenCalledWith("assets/embedded-app-sdk.mjs");
  expect(presenter).toMatchObject({
    target: "current_channel",
    capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
  });
  expect(presenter.target === "current_channel" && presenter.match(context)).toBe(configured);
  if (!configured) {
    await expect(presenter.availability(context)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  }
});
