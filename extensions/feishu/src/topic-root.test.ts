import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuReplyAnchorMessageId } from "./send.js";

const { mockListMessages } = vi.hoisted(() => ({ mockListMessages: vi.fn() }));

vi.mock("./configured-client.js", () => ({
  createConfiguredFeishuClient: vi.fn(() => ({
    im: { message: { list: mockListMessages } },
  })),
}));

const cfg = {} as ClawdbotConfig;

describe("resolveFeishuReplyAnchorMessageId", () => {
  // Successful lookups are cached per topic, so each case uses its own topic id.
  beforeEach(() => {
    mockListMessages.mockReset();
  });

  it("passes a message id through without a lookup", async () => {
    await expect(
      resolveFeishuReplyAnchorMessageId({ cfg, threadId: " om_reply_target " }),
    ).resolves.toBe("om_reply_target");
    await expect(resolveFeishuReplyAnchorMessageId({ cfg })).resolves.toBeUndefined();

    expect(mockListMessages).not.toHaveBeenCalled();
  });

  it("resolves a topic id to the topic's oldest message and reuses it", async () => {
    mockListMessages.mockResolvedValue({
      code: 0,
      data: { items: [{ message_id: "om_topic_root" }] },
    });

    await expect(
      resolveFeishuReplyAnchorMessageId({ cfg, threadId: "omt_topic", accountId: "work" }),
    ).resolves.toBe("om_topic_root");
    await expect(
      resolveFeishuReplyAnchorMessageId({ cfg, threadId: "omt_topic", accountId: "work" }),
    ).resolves.toBe("om_topic_root");

    expect(mockListMessages).toHaveBeenCalledTimes(1);
    expect(mockListMessages).toHaveBeenCalledWith({
      params: {
        container_id_type: "thread",
        container_id: "omt_topic",
        sort_type: "ByCreateTimeAsc",
        page_size: 1,
      },
    });
  });

  it("keeps the topic id when the lookup fails so the send owner still refuses a top-level post", async () => {
    mockListMessages.mockResolvedValue({ code: 99_991, msg: "invalid container" });
    await expect(
      resolveFeishuReplyAnchorMessageId({ cfg, threadId: "omt_unresolved" }),
    ).resolves.toBe("omt_unresolved");

    mockListMessages.mockRejectedValue(new Error("network down"));
    await expect(
      resolveFeishuReplyAnchorMessageId({ cfg, threadId: "omt_unreachable" }),
    ).resolves.toBe("omt_unreachable");

    mockListMessages.mockResolvedValue({ code: 0, data: { items: [] } });
    await expect(resolveFeishuReplyAnchorMessageId({ cfg, threadId: "omt_empty" })).resolves.toBe(
      "omt_empty",
    );
  });
});
