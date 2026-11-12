import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChannelHandler } from "../infra/outbound/deliver-channel.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools, createOpenClawToolsAsync } from "./openclaw-tools.js";

const sessionKey = "agent:main:route-less";
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { allow: ["message", "sessions_spawn"], codeMode: false, toolSearch: false },
};
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it("omits unsupported routes without turning presentation into a child or cron denial", () => {
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(createTestRegistry());
  const inheritedToolAllowlistRef: string[] = [];
  const cronCreatorToolAllowlistRef: Array<string | { name: string }> = [];
  const tools = createOpenClawCodingTools({
    config,
    sessionKey,
    inheritedToolAllowlistRef,
    cronCreatorToolAllowlistRef,
  });
  expect(tools.some((tool) => tool.name === "message")).toBe(false);
  expect(inheritedToolAllowlistRef).toContain("message");
  expect(cronCreatorToolAllowlistRef).toContainEqual(expect.objectContaining({ name: "message" }));
  expect(
    createOpenClawTools({ config, agentSessionKey: sessionKey }).some(
      (tool) => tool.name === "message",
    ),
  ).toBe(false);
  // An internal wake is not evidence of a new source transport or prompt capability.
  expect(
    createOpenClawCodingTools({
      config,
      sessionKey,
      messageProvider: "webchat",
      trigger: "event",
    }).some((tool) => tool.name === "message"),
  ).toBe(false);
});

it("retains a configured offline outbound-only adapter without an inbound channel or Gateway", async () => {
  const cfg: OpenClawConfig = { ...config, channels: { signal: { enabled: true } } };
  setRuntimeConfigSnapshot(cfg);
  const sendText = vi.fn(async () => ({
    channel: "signal" as const,
    messageId: "synthetic-receipt",
  }));
  const plugin = {
    ...createChannelTestPluginBase({ id: "signal" }),
    outbound: { deliveryMode: "direct" as const, sendText },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", source: "test", plugin }]));
  expect(
    createOpenClawTools({ config, agentSessionKey: sessionKey }).some(
      (tool) => tool.name === "message",
    ),
  ).toBe(true);
  const render = (sourceReplyOnly: boolean) =>
    createOpenClawTools({ config: cfg, agentSessionKey: sessionKey, sourceReplyOnly }).find(
      (tool) => tool.name === "message",
    );
  const normal = render(false);
  expect(normal).toBeDefined();
  expect(render(true)?.parameters).toEqual(normal?.parameters);
  expect(render(false)?.parameters).toEqual(normal?.parameters);
  const result = await normal!.execute("synthetic-send", {
    action: "send",
    channel: "signal",
    target: "+15550000001",
    message: "Synthetic adapter receipt",
  });
  expect(sendText).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).toContain("synthetic-receipt");
  const sourceOnly = createOpenClawTools({
    config: cfg,
    agentSessionKey: "agent:main:signal:direct:+15550000001",
    agentChannel: "signal",
    currentMessagingTarget: "+15550000001",
    sourceReplyOnly: true,
  }).find((tool) => tool.name === "message")!;
  for (const args of [
    { action: "send", target: "+15550000002", message: "Wrong target" },
    { action: "broadcast", targets: ["+15550000001"], message: "Broadcast" },
    { action: "react", messageId: "other", emoji: "✅" },
  ]) {
    await expect(sourceOnly.execute("source-negative", args)).rejects.toThrow(
      /Completion source replies/,
    );
  }
  expect(sendText).toHaveBeenCalledTimes(1);
});

it.each([
  { enabled: true, configured: false },
  { enabled: false, configured: true },
])("omits loaded senders without an enabled configured account: %o", (account) => {
  setRuntimeConfigSnapshot(config);
  const plugin = {
    ...createChannelTestPluginBase({
      id: "signal",
      config: {
        resolveAccount: () => account,
        isConfigured: (resolved) => resolved.configured,
      },
    }),
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async () => ({ channel: "signal", messageId: "unused" }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", source: "test", plugin }]));
  expect(
    createOpenClawTools({ config, agentSessionKey: sessionKey }).some(
      (tool) => tool.name === "message",
    ),
  ).toBe(false);
});

it.each([true, false])(
  "keeps unresolved async configuration in the synchronous factory, runtime configured=%s",
  async (configured) => {
    setRuntimeConfigSnapshot(config);
    const plugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        config: { isConfigured: async () => configured },
      }),
      outbound: {
        deliveryMode: "direct" as const,
        sendText: async () => ({ channel: "signal", messageId: "unused" }),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", source: "test", plugin }]));
    const options = { config, agentSessionKey: sessionKey };
    expect(createOpenClawTools(options).some((tool) => tool.name === "message")).toBe(true);
    expect((await createOpenClawToolsAsync(options)).some((tool) => tool.name === "message")).toBe(
      configured,
    );
  },
);

it("omits a payload-only adapter rejected by the actual delivery owner", async () => {
  setRuntimeConfigSnapshot(config);
  const sendPayload = vi.fn(async () => ({ channel: "signal", messageId: "unused" }));
  const plugin = {
    ...createChannelTestPluginBase({ id: "signal" }),
    outbound: { deliveryMode: "direct" as const, sendPayload },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", source: "test", plugin }]));
  await expect(
    createChannelHandler({ cfg: config, channel: "signal", to: "+15550000001" }),
  ).rejects.toThrow("Outbound not configured for channel: signal");
  expect(
    createOpenClawTools({ config, agentSessionKey: sessionKey }).some(
      (tool) => tool.name === "message",
    ),
  ).toBe(false);
  expect(sendPayload).not.toHaveBeenCalled();
});

it("retains a configured offline sender when its live action descriptor is empty", () => {
  setRuntimeConfigSnapshot(config);
  const plugin = {
    ...createChannelTestPluginBase({ id: "signal", config: { isConfigured: () => true } }),
    actions: { describeMessageTool: () => null },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async () => ({ channel: "signal", messageId: "unused" }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", source: "test", plugin }]));
  expect(
    createOpenClawTools({ config, agentSessionKey: sessionKey }).some(
      (tool) => tool.name === "message",
    ),
  ).toBe(true);
});

it("retains unbound configured senders when the bound channel has no route", async () => {
  const cfg: OpenClawConfig = {
    ...config,
    bindings: [{ agentId: "main", match: { channel: "telegram" } }],
    channels: { telegram: { enabled: false }, signal: { enabled: true } },
  };
  setRuntimeConfigSnapshot(cfg);
  const sendText = vi.fn(async () => ({
    channel: "signal" as const,
    messageId: "unbound-receipt",
  }));
  const signal = {
    ...createChannelTestPluginBase({ id: "signal", config: { isConfigured: () => true } }),
    outbound: { deliveryMode: "direct" as const, sendText },
  };
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createChannelTestPluginBase({ id: "telegram" }),
      },
      { pluginId: "signal", source: "test", plugin: signal },
    ]),
  );
  const tool = createOpenClawTools({ config: cfg, agentSessionKey: sessionKey }).find(
    (candidate) => candidate.name === "message",
  );
  expect(tool).toBeDefined();
  const result = await tool!.execute("unbound-send", {
    action: "send",
    channel: "signal",
    target: "+15550000001",
    message: "Unbound synthetic route",
  });
  expect(sendText).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).toContain("unbound-receipt");
});
