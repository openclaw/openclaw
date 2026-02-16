import { describe, expect, it, vi } from "vitest";

const handleSlackAction = vi.fn(async (params: any) => ({ ok: true, params }));

vi.mock("./runtime.js", () => ({
  getSlackRuntime: () => ({
    config: { loadConfig: () => ({}) },
    channel: { slack: { handleSlackAction } },
  }),
}));

import { slackPlugin } from "./channel.js";

describe("extensions/slack channel actions", () => {
  it("forwards threadId on message.read", async () => {
    handleSlackAction.mockClear();
    const cfg: any = { channels: { slack: { enabled: true } } };

    const res: any = await slackPlugin.actions.handleAction({
      action: "read",
      params: {
        to: "channel:C123",
        threadId: "1700000000.000100",
        limit: 10,
      },
      cfg,
      accountId: undefined,
      tokenContext: undefined,
    } as any);

    expect(res?.ok).toBe(true);
    expect(handleSlackAction).toHaveBeenCalledOnce();
    expect(handleSlackAction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "1700000000.000100" }),
      cfg,
    );
  });
});
