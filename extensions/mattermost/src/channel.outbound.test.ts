import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const { sendMessageMattermost } = vi.hoisted(() => ({
  sendMessageMattermost: vi.fn(async () => ({ messageId: "mm-1", channelId: "ch-1" })),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost,
}));

import { mattermostPlugin } from "./channel.js";

describe("mattermostPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageMattermost for outbound media sends", async () => {
    const result = await mattermostPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:abc",
      text: "hello",
      mediaUrl: "/tmp/workspace-agent/image.png",
      mediaLocalRoots: ["/tmp/workspace-agent"],
      accountId: "default",
    });

    expect(sendMessageMattermost).toHaveBeenCalledWith(
      "channel:abc",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace-agent/image.png",
        mediaLocalRoots: ["/tmp/workspace-agent"],
      }),
    );
    expect(result).toMatchObject({ channel: "mattermost", messageId: "mm-1" });
  });
});
