import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const sendText = vi.hoisted(() => vi.fn());

// mock-isolation: exercise the real plugin action without loading the live Feishu transport.
vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: { feishuOutbound: { sendText } },
}));

const cfg = {
  channels: {
    feishu: { enabled: true, appId: "cli_test", appSecret: "test-secret" },
  },
} satisfies OpenClawConfig;

beforeEach(() => {
  vi.resetAllMocks();
});
afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("Feishu threading reply anchors", () => {
  it.each([
    "b6a9fb30-6bc6-4ec0-83d1-10bc32e89a2d",
    "restart-sentinel:agent:main:feishu:123",
    "omt_thread",
    123,
    undefined,
  ])("rejects a non-native implicit reply anchor: %s", (currentMessageId) => {
    expect(
      feishuPlugin.threading?.buildToolContext?.({
        cfg,
        context: {
          To: "chat:oc_group_1",
          CurrentMessageId: currentMessageId,
          MessageThreadId: "omt_thread",
        },
      }),
    ).toMatchObject({
      currentMessageId: undefined,
      currentThreadTs: "omt_thread",
      currentMessagingTarget: "chat:oc_group_1",
    });
  });

  it("preserves a native implicit reply anchor", () => {
    expect(
      feishuPlugin.threading?.buildToolContext?.({
        cfg,
        context: { CurrentMessageId: " om_inbound " },
      }),
    ).toHaveProperty("currentMessageId", "om_inbound");
  });

  it("sends normally from a topic session with an internal trigger ID", async () => {
    sendText.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_sent",
      target: { kind: "chat", id: "oc_provider_authoritative" },
    });
    const toolContext = feishuPlugin.threading!.buildToolContext!({
      cfg,
      context: {
        To: "chat:oc_group_1",
        ChatType: "group",
        CurrentMessageId: "b6a9fb30-6bc6-4ec0-83d1-10bc32e89a2d",
        ReplyToMode: "all",
      },
    });
    const result = await feishuPlugin.actions!.handleAction!({
      channel: "feishu",
      cfg,
      action: "send",
      params: { to: "chat:oc_group_1", message: "Update." },
      sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
      toolContext,
    });
    expect(result.details).toMatchObject({ ok: true, messageId: "om_sent" });
    expect(sendText).toHaveBeenCalledExactlyOnceWith({
      cfg,
      accountId: undefined,
      to: "chat:oc_group_1",
      text: "Update.",
      mediaLocalRoots: undefined,
      replyToId: undefined,
    });
  });
});
