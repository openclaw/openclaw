import { InteractionResponseType } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as loggingCore from "openclaw/plugin-sdk/logging-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseComponentInteraction } from "../internal/discord.js";
import { createInteraction } from "../internal/interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { createDiscordActivityButton } from "./interaction.js";
import { setDiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setDiscordActivitiesRuntime(undefined);
});

const widgetId = "AAAAAAAAAAAAAAAAAAAAAA";
const applicationId = "123456789012345678";
const launchIdentity = { accountId: "default", channelId: "777", discordUserId: "42" };

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
  const button = createDiscordActivityButton(componentContext(), applicationId);
  if (!button) {
    throw new Error("expected activity button");
  }
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
  it("does not claim unrelated component custom IDs", () => {
    expect(createLaunchFixture().button.customIdParser("other:key=value").key).toBe("other");
  });

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

  it("launches for a channel member outside the agent allowlist", async () => {
    const { runtime, button, launchActivity, reply, interaction } = createLaunchFixture("99");
    const action = { type: "web-app", widgetId } as const;
    const rendered = buildDiscordPresentationComponents({
      blocks: [{ type: "buttons", buttons: [{ label: "Open widget", action }] }],
    });
    const actionBlock = rendered?.blocks?.find((block) => block.type === "actions");
    const customId =
      actionBlock?.type === "actions" ? actionBlock.buttons?.[0]?.internalCustomId : "";
    await button.run(interaction, button.customIdParser(customId ?? "").data ?? {});
    expect(launchActivity).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    const pending = runtime.store.consumePendingLaunch("default", "777", "99");
    await expect(pending).resolves.toMatchObject({ widgetId });
  });

  it("records the pending launch before acknowledging the interaction", async () => {
    const { runtime, launchActivity, run } = createLaunchFixture();
    const recordPendingLaunch = vi.spyOn(runtime.store, "recordPendingLaunch");
    await run();
    expect(recordPendingLaunch).toHaveBeenCalledWith(expect.objectContaining(launchIdentity));
    expect(launchActivity).toHaveBeenCalledOnce();
    expect(recordPendingLaunch.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      launchActivity.mock.invocationCallOrder[0] ?? Number.NaN,
    );
  });

  it("clears the exact watchdog handle when the pending launch write wins", async () => {
    const { launchActivity, run } = createLaunchFixture();
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    await run();
    const watchdogIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 250);
    expect(watchdogIndex).toBeGreaterThanOrEqual(0);
    const watchdogHandle = setTimeoutSpy.mock.results[watchdogIndex]?.value;
    expect(watchdogHandle).toBeDefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(watchdogHandle);
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
      expect(logError).toHaveBeenCalledTimes(1);
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
    const recordPendingLaunch = vi
      .spyOn(runtime.store, "recordPendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    await run();
    await run();
    expect(recordPendingLaunch).toHaveBeenCalledTimes(2);
    expect(launchActivity).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
  });

  it("replies ephemerally and does not launch for invalid widget data", async () => {
    const { button, launchActivity, reply, interaction } = createLaunchFixture();
    await button?.run(interaction, {});
    expect(reply).toHaveBeenCalledWith({
      content: "This widget is no longer valid.",
      ephemeral: true,
    });
    expect(launchActivity).not.toHaveBeenCalled();
  });
});
