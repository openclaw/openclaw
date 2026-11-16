import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuTestConfig } from "./bot.test-support.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuClient = vi.hoisted(() => vi.fn());
const resolveFeishuMediaList = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuClient }));
vi.mock("./bot-content.js", () => ({ resolveFeishuMediaList }));

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
const ctx = { chatId: "oc-group", messageId: "msg-001" };
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

function listMessages(items: Array<Record<string, unknown>>) {
  return vi.fn().mockResolvedValue({ code: 0, data: { items } });
}

describe("resolveFeishuMediaListWithLookback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    log.mockReset();
    resolveFeishuMediaList.mockReset().mockResolvedValue([]);
  });

  it("returns the current message media without a lookback", async () => {
    resolveFeishuMediaList.mockResolvedValueOnce([imageMedia]);
    const result = await resolveFeishuMediaListWithLookback({
      cfg,
      account,
      ctx,
      event,
      mediaMaxBytes: 1024,
      log,
      isGroup: true,
    });
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

    const result = await resolveFeishuMediaListWithLookback({
      cfg,
      account,
      ctx,
      event,
      mediaMaxBytes: 1024,
      log,
      isGroup: true,
    });

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
    const result = await resolveFeishuMediaListWithLookback({
      cfg,
      account,
      ctx,
      event,
      mediaMaxBytes: 1024,
      log,
      isGroup: false,
    });
    expect(result).toEqual([]);
    expect(createFeishuClient).not.toHaveBeenCalled();
  });

  it("returns current media when the lookback fails", async () => {
    createFeishuClient.mockReturnValue({
      im: { message: { list: vi.fn().mockRejectedValue(new Error("boom")) } },
    });
    const result = await resolveFeishuMediaListWithLookback({
      cfg,
      account,
      ctx,
      event,
      mediaMaxBytes: 1024,
      log,
      isGroup: true,
    });
    expect(result).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("lookback failed"));
  });
});
