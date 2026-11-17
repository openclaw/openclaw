import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuTestConfig } from "./bot.test-support.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuClient = vi.hoisted(() => vi.fn());
const resolveFeishuMediaList = vi.hoisted(() => vi.fn());
const shouldIncludeFetchedGroupContextMessage = vi.hoisted(() => vi.fn());
const buildFeishuFetchedContextPolicy = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuClient }));
vi.mock("./bot-content.js", () => ({ resolveFeishuMediaList }));
vi.mock("./policy.js", () => ({
  shouldIncludeFetchedGroupContextMessage,
  buildFeishuFetchedContextPolicy,
}));

import { resolveFeishuMediaListWithLookback } from "./bot-recent-images.js";

const cfg = createFeishuTestConfig({ dmPolicy: "open" });
const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  appId: "cli_test",
  appSecret: "secret",
  domain: "feishu",
  config: {},
} as ResolvedFeishuAccount;
const log = vi.fn();
const ctx = {
  chatId: "oc-group",
  messageId: "msg-001",
  mentionedBot: true,
  chatType: "group" as const,
};
const fetchedContextPolicy = {
  cfg,
  accountId: "default",
  chatId: "oc-group",
  isGroup: true,
  allowFrom: ["ou-alice"],
  mode: "allowlist" as const,
};
const event = {
  sender: { sender_id: { open_id: "ou-sender" } },
  message: {
    message_id: "msg-001",
    chat_id: "oc-group",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "hello" }),
  },
} as FeishuMessageEvent;
const imageMedia = { path: "/tmp/recent.png", contentType: "image/png", kind: "image" } as const;
const sender = (id: string) => ({ id, id_type: "open_id", sender_type: "user" });
const imageItem = (messageId: string, imageKey: string, extra: Record<string, unknown> = {}) => ({
  message_id: messageId,
  msg_type: "image",
  sender: sender("ou-alice"),
  body: { content: JSON.stringify({ image_key: imageKey }) },
  ...extra,
});

function lookback(
  overrides: Partial<Parameters<typeof resolveFeishuMediaListWithLookback>[0]> = {},
) {
  return resolveFeishuMediaListWithLookback({
    cfg,
    account,
    ctx,
    event,
    mediaMaxBytes: 1024,
    log,
    isGroup: true,
    ...overrides,
  });
}

function listMessages(items: Array<Record<string, unknown>>) {
  return vi.fn().mockResolvedValue({ code: 0, data: { items } });
}

describe("resolveFeishuMediaListWithLookback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    log.mockReset();
    resolveFeishuMediaList.mockReset().mockResolvedValue([]);
    shouldIncludeFetchedGroupContextMessage.mockReset().mockResolvedValue(true);
    buildFeishuFetchedContextPolicy.mockReset().mockReturnValue(fetchedContextPolicy);
  });

  it("returns the current message media without a lookback", async () => {
    resolveFeishuMediaList.mockResolvedValueOnce([imageMedia]);
    const result = await lookback();
    expect(result).toEqual([imageMedia]);
    expect(createFeishuClient).not.toHaveBeenCalled();
  });

  it("attaches recent group images to a media-less @-mention", async () => {
    const list = listMessages([
      {
        message_id: "om-recent-image-001",
        msg_type: "image",
        body: { content: JSON.stringify({ image_key: "img_recent_001" }) },
      },
      {
        message_id: "om-recent-text-001",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "hello" }) },
      },
    ]);
    createFeishuClient.mockReturnValue({ im: { message: { list } } });
    resolveFeishuMediaList.mockResolvedValueOnce([]).mockResolvedValueOnce([imageMedia]);

    const result = await lookback();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          container_id_type: "chat",
          container_id: "oc-group",
          sort_type: "ByCreateTimeDesc",
        }),
      }),
    );
    expect(resolveFeishuMediaList).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-recent-image-001", messageType: "image" }),
    );
    expect(result).toEqual([imageMedia]);
  });

  it("skips the lookback outside groups", async () => {
    const result = await lookback({ isGroup: false });
    expect(result).toEqual([]);
    expect(createFeishuClient).not.toHaveBeenCalled();
  });

  it("skips the lookback when the bot was not @-mentioned", async () => {
    const result = await lookback({ ctx: { ...ctx, mentionedBot: false } });
    expect(result).toEqual([]);
    expect(createFeishuClient).not.toHaveBeenCalled();
  });

  it("returns current media when the lookback fails", async () => {
    createFeishuClient.mockReturnValue({
      im: { message: { list: vi.fn().mockRejectedValue(new Error("boom")) } },
    });
    const result = await lookback();
    expect(result).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lookback failed"));
  });

  it("does not attach images from a sender outside the visibility allowlist", async () => {
    shouldIncludeFetchedGroupContextMessage.mockImplementation(
      async ({ senderId }: { senderId?: string }) => senderId !== "ou-bob",
    );
    const list = listMessages([
      {
        message_id: "om-bob-image-001",
        msg_type: "image",
        sender: sender("ou-bob"),
        body: { content: JSON.stringify({ image_key: "img_bob_001" }) },
      },
      imageItem("om-alice-image-001", "img_alice_001"),
    ]);
    createFeishuClient.mockReturnValue({ im: { message: { list } } });
    resolveFeishuMediaList.mockResolvedValueOnce([]).mockResolvedValueOnce([imageMedia]);

    const result = await lookback();

    expect(shouldIncludeFetchedGroupContextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "history", senderId: "ou-bob" }),
    );
    expect(resolveFeishuMediaList).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-bob-image-001" }),
    );
    expect(resolveFeishuMediaList).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-alice-image-001", messageType: "image" }),
    );
    expect(result).toEqual([imageMedia]);
  });

  it("caps a 6-image post at 5 downloads, images only", async () => {
    const sixImages = Array.from({ length: 6 }, (_, i) => ({
      tag: "img",
      image_key: `img_post_${i}`,
    }));
    const list = listMessages([
      {
        message_id: "om-post-001",
        msg_type: "post",
        sender: sender("ou-alice"),
        body: { content: JSON.stringify({ title: "", content: [sixImages] }) },
      },
    ]);
    createFeishuClient.mockReturnValue({ im: { message: { list } } });

    await lookback();

    expect(resolveFeishuMediaList).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om-post-001",
        messageType: "post",
        allowedKinds: ["image"],
        maxItems: 5,
      }),
    );
  });

  it("excludes images created after the triggering @-mention", async () => {
    const timedEvent = {
      ...event,
      message: { ...event.message, create_time: "1700000002000" },
    } as FeishuMessageEvent;
    const list = listMessages([
      imageItem("om-later-image-001", "img_later_001", { create_time: "1700000003000" }),
      imageItem("om-earlier-image-001", "img_earlier_001", { create_time: "1700000001000" }),
    ]);
    createFeishuClient.mockReturnValue({ im: { message: { list } } });
    resolveFeishuMediaList.mockResolvedValueOnce([]).mockResolvedValueOnce([imageMedia]);

    const result = await lookback({ event: timedEvent });

    expect(resolveFeishuMediaList).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-later-image-001" }),
    );
    expect(resolveFeishuMediaList).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-earlier-image-001" }),
    );
    expect(result).toEqual([imageMedia]);
  });

  it("stays inside the triggering topic in topic groups", async () => {
    const topicCtx = { ...ctx, chatType: "topic_group" as const, threadId: "thread-a" };
    const list = listMessages([
      imageItem("om-topic-b-image-001", "img_topic_b_001", {
        thread_id: "thread-b",
        root_id: "root-b",
      }),
      imageItem("om-topic-a-image-001", "img_topic_a_001", {
        thread_id: "thread-a",
        root_id: "root-a",
      }),
    ]);
    createFeishuClient.mockReturnValue({ im: { message: { list } } });
    resolveFeishuMediaList.mockResolvedValueOnce([]).mockResolvedValueOnce([imageMedia]);

    const result = await lookback({ ctx: topicCtx });

    expect(resolveFeishuMediaList).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-topic-b-image-001" }),
    );
    expect(resolveFeishuMediaList).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om-topic-a-image-001" }),
    );
    expect(result).toEqual([imageMedia]);
  });
});
