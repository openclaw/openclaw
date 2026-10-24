import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const feishuOutboundSendTextMock = vi.hoisted(() => vi.fn());

// The action send path only needs the outbound text delegate; importing the full runtime
// would construct provider clients this test never exercises.
// mock-isolation: action send path only needs the outbound text delegate
vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    feishuOutbound: {
      sendText: feishuOutboundSendTextMock,
    },
  },
}));

const cfg = {
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_main",
      appSecret: "secret_main",
      actions: { reactions: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    },
  },
} satisfies OpenClawConfig;
const actionContext = { cfg, accountId: undefined };
type Action = ChannelMessageActionContext["action"];
type Context = Partial<Omit<ChannelMessageActionContext, "action" | "params">>;
const run = (action: Action, params: Record<string, unknown>, context: Context = {}) =>
  feishuPlugin.actions!.handleAction!({ channel: "feishu", cfg, action, params, ...context });
const textDelivery = () =>
  feishuOutboundSendTextMock.mockResolvedValueOnce({
    channel: "feishu",
    messageId: "om_sent",
    target: { kind: "chat", id: "oc_provider_authoritative" },
  });
const topicContext = {
  sessionKey: "feishu:group:oc_group_1:topic:om_inbound",
  toolContext: { currentChannelId: "oc_group_1", currentMessageId: "om_inbound" },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Feishu topic routing", () => {
  it.each(["implicit", "explicit"] as const)(
    "preserves prepared %s reply semantics",
    async (source) => {
      textDelivery();
      await run(
        "send",
        { to: "chat:oc_group_1", text: "reply", replyTo: "om_inbound" },
        {
          ...topicContext,
          sessionKey: "feishu:group:oc_group_1:topic:om_inbound:sender:ou_user",
          reply:
            source === "explicit"
              ? { source, replyToId: "om_inbound" }
              : { source, replyToId: "om_inbound", mode: "all" },
        },
      );
      expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
        ...actionContext,
        to: "chat:oc_group_1",
        text: "reply",
        mediaLocalRoots: undefined,
        ...(source === "implicit" ? { threadId: "om_inbound" } : { replyToId: "om_inbound" }),
      });
    },
  );
  it("keeps a message-tool send in the topic when the trigger id is synthetic", async () => {
    textDelivery();
    await run(
      "send",
      { to: "chat:oc_group_1", text: "hello" },
      {
        ...topicContext,
        toolContext: {
          currentChannelId: "oc_group_1",
          currentMessageId: undefined,
          currentThreadTs: "om_topic_root",
        },
      },
    );
    expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      to: "chat:oc_group_1",
      text: "hello",
      mediaLocalRoots: undefined,
      threadId: "om_topic_root",
    });
  });
  it("does not inherit a non-native topic root", async () => {
    textDelivery();
    await run(
      "send",
      { to: "chat:oc_group_1", text: "hello" },
      {
        ...topicContext,
        toolContext: {
          currentChannelId: "oc_group_1",
          currentMessageId: undefined,
          currentThreadTs: "855a9b56-ced7-4627-b9ca-454c30a91f9d",
        },
      },
    );
    expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
      ...actionContext,
      to: "chat:oc_group_1",
      text: "hello",
      mediaLocalRoots: undefined,
      replyToId: undefined,
    });
  });
  it.each([
    { name: "destination changes", params: { to: "chat:oc_other" }, context: topicContext },
    { name: "top-level requested", params: { topLevel: true }, context: topicContext },
    { name: "inheritance suppressed", params: { threadId: null }, context: topicContext },
    { name: "account changes", context: { ...topicContext, requesterAccountId: "other" } },
    {
      name: "session has no topic",
      context: { ...topicContext, sessionKey: "feishu:group:oc_group_1" },
    },
    { name: "inbound context is absent", context: { ...topicContext, toolContext: {} } },
  ] satisfies Array<{ name: string; params?: Record<string, unknown>; context: Context }>)(
    "does not inherit a source topic when $name",
    async ({ params, context }) => {
      textDelivery();
      const target = { to: "chat:oc_group_1", ...params };
      await run("send", { ...target, text: "hello" }, context);
      expect(feishuOutboundSendTextMock).toHaveBeenCalledExactlyOnceWith({
        ...actionContext,
        to: target.to,
        text: "hello",
        mediaLocalRoots: undefined,
        replyToId: undefined,
      });
    },
  );
  it("requires a thread-reply anchor", async () => {
    await expect(run("thread-reply", { to: "chat:oc_group_1", message: "reply" })).rejects.toThrow(
      "Feishu thread-reply requires messageId.",
    );
  });
  it("rejects unsupported actions", async () => {
    await expect(run("search", {})).rejects.toThrow('Unsupported Feishu action: "search"');
  });
});
