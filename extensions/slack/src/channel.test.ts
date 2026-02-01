import { describe, expect, it, vi } from "vitest";

// Mock runtime so we can intercept handleSlackAction calls.
vi.mock("./runtime.js", () => {
  const handleSlackAction = vi.fn(async (params: any) => ({ ok: true, params }));
  return {
    getSlackRuntime: () => ({
      config: { loadConfig: () => ({}) },
      channel: { slack: { handleSlackAction } },
    }),
  };
});

import { slackPlugin } from "./channel.js";

describe("extensions/slack channel actions", () => {
  it("forwards threadId on message.read", async () => {
    const cfg: any = { channels: { slack: { enabled: true } } };

    // Minimal action call shape expected by ChannelPlugin actions.
    const res: any = await slackPlugin.actions.handleAction({
      action: "read",
      params: {
        // resolveChannelId() uses channelId or to.
        to: "channel:C123",
        threadId: "1700000000.000100",
        limit: 10,
      },
      cfg,
      accountId: undefined,
      toolContext: undefined,
    } as any);

    expect(res?.ok).toBe(true);
    expect(res?.params?.threadId).toBe("1700000000.000100");
  });
});
