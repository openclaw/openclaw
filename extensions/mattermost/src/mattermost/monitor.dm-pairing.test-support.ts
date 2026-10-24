import { expect, it, vi, type Mock } from "vitest";
import { createChannelPairingController, type OpenClawConfig } from "./runtime-api.js";

export function registerMattermostDmPairingTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (config: OpenClawConfig) => unknown;
  receivePost: (
    post: {
      id: string;
      message: string;
      senderId?: string;
      senderName?: string;
      channelId?: string;
      includeChannelLabels?: boolean;
    },
    config?: OpenClawConfig,
  ) => Promise<unknown>;
  mockState: {
    runtimeCore: unknown;
    resolveChannelInfo: Mock;
    sendMessageMattermost: Mock;
    dispatchInboundMessage: Mock;
  };
  publicChannel: object;
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState, publicChannel } = harness;
  it("answers an unpaired direct message through the shared pairing challenge", async () => {
    const config: OpenClawConfig = {
      channels: {
        mattermost: { ...testConfig.channels?.mattermost, dmPolicy: "pairing", allowFrom: [] },
      },
    };
    mockState.runtimeCore = createRuntimeCore(config);
    mockState.resolveChannelInfo.mockResolvedValue({
      ...publicChannel,
      id: "dm-1",
      name: "",
      display_name: "",
      type: "D",
    });
    await receivePost(
      {
        id: "post-stranger",
        message: "hello",
        senderId: "new-user",
        senderName: "mallory",
        channelId: "dm-1",
        includeChannelLabels: false,
      },
      config,
    );
    // The shared challenge stores the request and runs channel_pairing_requested, as other channels do.
    const pairing = vi.mocked(createChannelPairingController).mock.results.at(-1)?.value;
    expect(pairing?.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "new-user",
        senderIdLine: "Your Mattermost user id: new-user",
        meta: { name: "mallory" },
      }),
    );
    expect(pairing?.upsertPairingRequest).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:dm-1",
      "pairing required",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
  });
}
