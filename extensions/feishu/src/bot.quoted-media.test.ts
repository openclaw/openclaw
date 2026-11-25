import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuMessage } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
  fetchedMessage,
  replyDispatcher,
  withFeishuRuntimeDefaults,
} from "./bot.test-support.js";
import { setFeishuRuntime } from "./runtime.js";

const { dispatch, getMessage, resolveRoute, saveMessageResource } = vi.hoisted(() => ({
  dispatch: vi
    .fn<PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]>()
    .mockResolvedValue({ queuedFinal: false, counts: { block: 0, tool: 0, final: 1 } }),
  getMessage: vi.fn<typeof import("./send.js").getMessageFeishu>(),
  resolveRoute: vi.fn<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>(() =>
    createFeishuTestRoute(),
  ),
  saveMessageResource: vi.fn<typeof import("./media.js").saveMessageResourceFeishu>(),
}));

// mock-isolation: Fixture quoted messages replace Feishu network requests.
vi.mock("./send.js", () => ({
  getMessageFeishu: getMessage,
  listFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  sendMessageFeishu: vi.fn(),
}));
// mock-isolation: Fixture saved media avoids downloads and attachment writes.
vi.mock("./media.js", () => ({ saveMessageResourceFeishu: saveMessageResource }));
// mock-isolation: Capture delivery without constructing a live transport dispatcher.
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: vi.fn(() => replyDispatcher()),
}));
// mock-isolation: Keep preview policy independent of persisted reasoning settings.
vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: vi.fn(async () => false),
}));
// mock-isolation: Avoid chat metadata lookups unrelated to quoted media delivery.
vi.mock("./bot-group-name.js", () => ({ resolveGroupName: vi.fn(async () => undefined) }));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: ({
      route,
    }: Parameters<typeof actual.resolveConfiguredBindingRoute>[0]) => ({
      route,
      bindingResolution: null,
    }),
    resolveRuntimeConversationBindingRoute: ({
      route,
    }: Parameters<typeof actual.resolveRuntimeConversationBindingRoute>[0]) => ({
      route,
      bindingRecord: null,
    }),
  };
});

afterAll(() => vi.doUnmock("./bot-group-name.js"));

describe("Feishu quoted media handler context", () => {
  const parentId = "om-parent-image";
  let runtimeConfig = {} as ClawdbotConfig;

  function config(contextVisibility: "open" | "allowlist") {
    return createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "sec_test", // pragma: allowlist secret
      groupPolicy: "open",
      contextVisibility,
      resolveSenderNames: false,
      groups: { "oc-group": { requireMention: true } },
      ...(contextVisibility === "allowlist" ? { groupSenderAllowFrom: ["ou-requester"] } : {}),
    });
  }

  function event(messageId: string) {
    return createFeishuTestEvent({
      messageId,
      senderOpenId: "ou-requester",
      chatId: "oc-group",
      chatType: "group",
      text: "@_bot describe this image",
      message: {
        parent_id: parentId,
        mentions: [{ key: "@_bot", id: { open_id: "ou-bot" }, name: "Bot" }],
      },
    });
  }

  async function receive(contextVisibility: "open" | "allowlist", messageId: string) {
    const cfg = config(contextVisibility);
    runtimeConfig = withFeishuRuntimeDefaults(cfg);
    await handleFeishuMessage({
      cfg,
      event: event(messageId),
      botOpenId: "ou-bot",
      runtime: createRuntimeEnv(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getMessage.mockReset();
    saveMessageResource.mockReset().mockResolvedValue({
      id: "quoted-image.png",
      path: "/tmp/quoted-image.png",
      size: 12,
      contentType: "image/png",
    });
    setFeishuRuntime(
      createPluginRuntimeMock({
        config: { current: () => runtimeConfig },
        channel: {
          inbound: { buildContext: buildChannelInboundEventContext },
          reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
          routing: { resolveAgentRoute: resolveRoute },
        },
      }),
    );
  });

  it("delivers visible quoted image media through the inbound handler context", async () => {
    getMessage.mockResolvedValueOnce(
      fetchedMessage(parentId, "[image message]", {
        senderId: "ou-image-sender",
        senderType: "user",
        contentType: "image",
        rawContent: JSON.stringify({ image_key: "img_quoted" }),
      }),
    );

    await receive("open", "msg-visible-quote");

    expect(saveMessageResource).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: parentId, fileKey: "img_quoted", type: "image" }),
    );
    expect(dispatch.mock.calls[0]?.[0].ctx).toMatchObject({
      ReplyToBody: "[image message]",
      media: [{ path: "/tmp/quoted-image.png", contentType: "image/png", kind: "image" }],
    });
  });

  it("does not download quoted media hidden by the group context policy", async () => {
    getMessage.mockResolvedValueOnce(
      fetchedMessage(parentId, "[image message]", {
        senderId: "ou-blocked",
        senderType: "user",
        contentType: "image",
        rawContent: JSON.stringify({ image_key: "img_hidden" }),
      }),
    );

    await receive("allowlist", "msg-hidden-quote");

    expect(saveMessageResource).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]?.[0].ctx.ReplyToBody).toBeUndefined();
  });
});
