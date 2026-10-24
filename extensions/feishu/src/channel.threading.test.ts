import { describe, expect, it } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const cfg = {
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_main",
      appSecret: "secret_main",
    },
  },
} satisfies OpenClawConfig;

describe("Feishu threading reply anchors", () => {
  it("rejects synthetic internal ids as message-tool reply targets", () => {
    const context = feishuPlugin.threading?.buildToolContext?.({
      cfg,
      context: {
        To: "chat:oc_group_1",
        CurrentMessageId: "855a9b56-ced7-4627-b9ca-454c30a91f9d",
      },
    });
    // The explicit key is what tells the shared owner not to fall back to the
    // generic trigger id (see buildThreadingToolContext).
    expect(Object.hasOwn(context ?? {}, "currentMessageId")).toBe(true);
    expect(context?.currentMessageId).toBeUndefined();
  });

  it("keeps native message ids as message-tool reply targets", () => {
    expect(
      feishuPlugin.threading?.buildToolContext?.({
        cfg,
        context: { To: "chat:oc_group_1", CurrentMessageId: "om_inbound" },
      }),
    ).toMatchObject({ currentMessageId: "om_inbound" });
  });

  it("keeps the native topic root when the message id is synthetic", () => {
    const context = feishuPlugin.threading?.buildToolContext?.({
      cfg,
      context: {
        To: "chat:oc_group_1",
        CurrentMessageId: "855a9b56-ced7-4627-b9ca-454c30a91f9d",
        MessageThreadId: "om_topic_root",
      },
    });
    expect(context).toMatchObject({
      currentMessageId: undefined,
      currentThreadTs: "om_topic_root",
    });
  });

  it("drops synthetic reply anchors while preserving native replies and threads", () => {
    const resolve = feishuPlugin.threading?.resolveReplyTransport;
    expect(
      resolve?.({
        cfg,
        threadId: "om_root",
        replyToId: "855a9b56-ced7-4627-b9ca-454c30a91f9d",
      }),
    ).toEqual({ replyToId: null, threadId: "om_root" });
    expect(resolve?.({ cfg, threadId: "om_root", replyToId: "om_reply" })).toEqual({
      replyToId: "om_reply",
      threadId: "om_root",
    });
    expect(resolve?.({ cfg, threadId: "omt_topic" })).toEqual({
      replyToId: null,
      threadId: "omt_topic",
    });
  });
});
