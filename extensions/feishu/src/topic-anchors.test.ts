import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuTopicAutoThreadAnchor } from "./topic-anchors.js";

const { mockResolveAnchor, mockLoadRuntime } = vi.hoisted(() => {
  const resolveAnchor = vi.fn();
  return {
    mockResolveAnchor: resolveAnchor,
    mockLoadRuntime: vi.fn(async () => ({
      resolveFeishuReplyAnchorMessageId: resolveAnchor,
    })),
  };
});

// mock-isolation: the lazy runtime barrel is stubbed so the anchor decision stays unit-scoped.
vi.mock("./channel-runtime-loader.js", () => ({
  loadFeishuChannelRuntime: mockLoadRuntime,
}));

const cfg = {} as ClawdbotConfig;

function topicContext(
  overrides: {
    sessionKey?: string;
    currentChannelId?: string;
    messageId?: string;
    params?: Record<string, unknown>;
  } = {},
) {
  return {
    cfg,
    params: overrides.params ?? {},
    sessionKey: overrides.sessionKey ?? "feishu:group:oc_group:topic:omt_topic",
    toolContext: {
      currentChannelId: overrides.currentChannelId ?? "oc_group",
      currentChannelProvider: "feishu",
      currentMessageId: overrides.messageId,
    },
  };
}

describe("resolveFeishuTopicAutoThreadAnchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a native inbound message id without a lookup", async () => {
    await expect(
      resolveFeishuTopicAutoThreadAnchor(
        topicContext({ messageId: "om_inbound" }),
        "work",
        "chat:oc_group",
      ),
    ).resolves.toBe("om_inbound");

    expect(mockLoadRuntime).not.toHaveBeenCalled();
  });

  it("resolves the session topic to its reply anchor for agent-initiated sends", async () => {
    mockResolveAnchor.mockResolvedValueOnce("om_topic_root");

    await expect(
      resolveFeishuTopicAutoThreadAnchor(topicContext(), "work", "chat:oc_group"),
    ).resolves.toBe("om_topic_root");

    expect(mockResolveAnchor).toHaveBeenCalledWith({
      cfg,
      threadId: "omt_topic",
      accountId: "work",
    });
  });

  it("refuses to infer an anchor from a session in another chat", async () => {
    await expect(
      resolveFeishuTopicAutoThreadAnchor(
        topicContext({ sessionKey: "feishu:group:oc_source:topic:omt_source_topic" }),
        "work",
        "chat:oc_destination",
      ),
    ).resolves.toBeUndefined();

    expect(mockLoadRuntime).not.toHaveBeenCalled();
  });

  it("honors explicit top-level sends", async () => {
    await expect(
      resolveFeishuTopicAutoThreadAnchor(
        topicContext({ params: { topLevel: true } }),
        "work",
        "chat:oc_group",
      ),
    ).resolves.toBeUndefined();

    expect(mockLoadRuntime).not.toHaveBeenCalled();
  });
});
