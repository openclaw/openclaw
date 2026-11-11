import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const sendMessageMattermostMock = vi.hoisted(() => vi.fn());

// mock-isolation: Assert channel dispatch and hooks without making Mattermost API requests.
vi.mock("./mattermost/send.js", () => ({ sendMessageMattermost: sendMessageMattermostMock }));

import { mattermostPlugin } from "./channel.js";

function installSendingHook(result: { content?: string; cancel?: boolean }) {
  const registry = createEmptyPluginRegistry();
  const handler = vi.fn().mockResolvedValue(result);
  addTestHook({
    registry,
    pluginId: "test-policy",
    hookName: "message_sending",
    handler: handler as PluginHookRegistration["handler"],
  });
  initializeGlobalHookRunner(registry);
  return handler;
}

const deliver = (text: string, opts: Partial<Parameters<typeof sendDurableMessageBatch>[0]>) =>
  sendDurableMessageBatch({
    cfg: {},
    channel: "mattermost",
    to: "channel:CHAN1",
    payloads: [{ text }],
    ...opts,
  });

beforeEach(() => {
  sendMessageMattermostMock.mockReset().mockImplementation(async (_to, text, options) => {
    const result = { messageId: "post-1", channelId: "CHAN1", content: text };
    await options?.onDeliveryResult?.(result);
    return result;
  });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "mattermost", plugin: mattermostPlugin, source: "test" }]),
  );
  resetGlobalHookRunner();
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

const splitCfg = { channels: { mattermost: { textChunkLimit: 14 } } };

it.each<[string, string, string[], OpenClawConfig]>([
  ["internal tool traces", "Done.\n⚠️ 🛠️ `search repos (agent)` failed", ["Done."], {}],
  ["ordinary prose", "The pipeline has 3 open deals.", ["The pipeline has 3 open deals."], {}],
  ["fence", "```py\n  a\n  b\n```\n\nend", ["```py\n  a\n```", "```py\n  b\n```", "end"], splitCfg],
])("sends sanitized %s through the channel handler", async (_name, text, expected, cfg) => {
  await deliver(text, { to: "channel:team-1", skipQueue: true, cfg });
  expect(sendMessageMattermostMock.mock.calls.map((call) => call[1])).toEqual(expected);
});

it.each([
  ["applies a message rewrite exactly once", { content: "rewritten once" }, "rewritten once"],
  ["does not create a provider post when the shared hook cancels", { cancel: true }, undefined],
])("%s", async (_name, hookResult, sent) => {
  const handler = installSendingHook(hookResult);
  const result = await deliver("original", { accountId: "default" });
  expect(handler).toHaveBeenCalledTimes(1);
  if (sent) {
    expect(sendMessageMattermostMock).toHaveBeenCalledExactlyOnceWith(
      "channel:CHAN1",
      sent,
      expect.objectContaining({ accountId: "default", onDeliveryResult: expect.any(Function) }),
    );
  } else {
    expect(sendMessageMattermostMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "suppressed", results: [] });
  }
});
