import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const renderPresentation = vi.hoisted(() => vi.fn());
const sendPayload = vi.hoisted(() => vi.fn());
const createFeishuClient = vi.hoisted(() => vi.fn());
const sendStickerFeishu = vi.hoisted(() => vi.fn());
const resolveFeishuReplyAnchorMessageId = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    feishuOutbound: { renderPresentation, sendPayload },
    sendStickerFeishu,
    resolveFeishuReplyAnchorMessageId,
  },
}));

afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("Feishu public outbound presentation hooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const presentation = { title: "Status", blocks: [{ type: "text" as const, text: "Ready" }] };
  const payload = { presentation };
  const ctx = {
    cfg: {},
    to: "chat:oc_group",
    accountId: "work",
    threadId: "om_parent",
    text: "",
    payload,
  };

  it("renders and sends native payloads through the advertised plugin capability", async () => {
    const rendered = { channelData: { feishu: { card: { schema: "2.0" } } } };
    const receipt = { channel: "feishu", messageId: "om_card" };
    renderPresentation.mockResolvedValueOnce(rendered);
    sendPayload.mockResolvedValueOnce(receipt);

    expect(feishuPlugin.outbound?.presentationCapabilities?.supported).toBe(true);
    const renderContext = { ctx, payload, presentation };
    const result = await feishuPlugin.outbound?.renderPresentation?.(renderContext);
    expect(renderPresentation).toHaveBeenCalledExactlyOnceWith(renderContext);
    expect(result).toBe(rendered);

    const sendContext = { ...ctx, payload: rendered };
    await expect(feishuPlugin.outbound?.sendPayload?.(sendContext)).resolves.toBe(receipt);
    expect(sendPayload).toHaveBeenCalledExactlyOnceWith(sendContext);
  });
});

describe("Feishu topic session delivery identity", () => {
  it("owns topic and sender session inheritance", () => {
    for (const [rawId, threadId, parents] of [
      ["oc_group:Topic:om_root:Sender:ou_user", "om_root", ["oc_group:topic:om_root", "oc_group"]],
      ["oc_group:topic:om_root", "om_root", ["oc_group"]],
    ] as const) {
      expect(
        feishuPlugin.messaging?.resolveSessionConversation?.({ kind: "group", rawId }),
      ).toEqual({
        id: rawId.toLowerCase(),
        threadId,
        baseConversationId: "oc_group",
        parentConversationCandidates: parents,
      });
    }
  });

  it("lets core reuse a group session's route thread id for heartbeats", () => {
    // Without this opt-in, a heartbeat that targets the session's last route posts a new
    // top-level message, which starts a new topic in a Feishu topic chat.
    expect(feishuPlugin.messaging?.preserveHeartbeatThreadIdForGroupRoute).toBe(true);
  });
});

describe("Feishu topic reply anchoring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createFeishuClient.mockReturnValue({ tag: "client" });
    // An unresolved topic keeps its own id; the send owner decides whether to fall back.
    resolveFeishuReplyAnchorMessageId.mockImplementation(
      async ({ threadId }: { threadId?: string | null }) => threadId ?? undefined,
    );
  });

  const stickerCfg = {
    channels: {
      feishu: {
        accounts: {
          work: { appId: "cli_work", appSecret: "secret_work", actions: { sticker: true } },
        },
      },
    },
  } satisfies OpenClawConfig;
  const receipt = { messageId: "om_sticker", chatId: "oc_group_1" };

  // No inbound message id: heartbeats and scheduled turns look exactly like this.
  const sendStickerForTopicSession = () =>
    feishuPlugin.actions!.handleAction!({
      channel: "feishu",
      action: "sticker",
      params: { fileId: "file_sticker" },
      cfg: stickerCfg,
      accountId: "work",
      sessionKey: "feishu:group:oc_group_1:topic:omt_topic_root",
      toolContext: { currentChannelId: "oc_group_1" },
    });

  it("resolves a topic session key to the topic's reply anchor for agent-initiated sends", async () => {
    sendStickerFeishu.mockResolvedValueOnce(receipt);
    resolveFeishuReplyAnchorMessageId.mockResolvedValueOnce("om_topic_root");

    await sendStickerForTopicSession();
    // A reply addresses a message, so the topic id (`omt_…`) must be resolved first.
    expect(resolveFeishuReplyAnchorMessageId).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "omt_topic_root" }),
    );
    expect(sendStickerFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "om_topic_root", replyInThread: true }),
    );
  });

  it("keeps the topic target when it cannot be resolved, so the send owner decides", async () => {
    sendStickerFeishu.mockResolvedValueOnce(receipt);
    // An unresolved lookup returns the topic id unchanged (see resolveFeishuReplyAnchorMessageId).
    resolveFeishuReplyAnchorMessageId.mockResolvedValueOnce("omt_topic_root");

    await sendStickerForTopicSession();
    // Clearing the target here would post a new top-level topic; the send owner refuses that
    // fallback for threaded replies, so the topic target must survive an unresolved lookup.
    expect(sendStickerFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "omt_topic_root", replyInThread: true }),
    );
  });
});
