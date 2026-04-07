import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

const sendMessageBlueBubblesMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", () => ({
  blueBubblesChannelRuntime: {
    sendMessageBlueBubbles: sendMessageBlueBubblesMock,
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

let bluebubblesPlugin: typeof import("./channel.js").bluebubblesPlugin;

describe("bluebubblesPlugin.pairing.notifyApproval", () => {
  beforeAll(async () => {
    ({ bluebubblesPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    sendMessageBlueBubblesMock.mockReset();
    sendMessageBlueBubblesMock.mockResolvedValue({ messageId: "bb-pairing" });
  });

  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          accounts: {
            work: {
              serverUrl: "http://localhost:1234",
              password: "test-password",
            },
          },
        },
      },
    } as OpenClawConfig;

    await bluebubblesPlugin.pairing?.notifyApproval?.({
      cfg,
      id: "+15551234567",
      accountId: "work",
    });

    expect(sendMessageBlueBubblesMock).toHaveBeenCalledWith(
      "+15551234567",
      expect.any(String),
      expect.objectContaining({
        cfg,
        accountId: "work",
      }),
    );
  });
});
