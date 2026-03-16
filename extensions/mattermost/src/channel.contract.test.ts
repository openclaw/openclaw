import type { OpenClawConfig } from "openclaw/plugin-sdk/mattermost";
import { describe } from "vitest";
import { installChannelActionsContractSuite } from "../../../src/test-utils/channel-actions-contract.js";
import { installChannelPluginContractSuite } from "../../../src/test-utils/channel-plugin-contract.js";
import { mattermostPlugin } from "./channel.js";

describe("mattermostPlugin contract", () => {
  installChannelPluginContractSuite({
    plugin: mattermostPlugin,
  });

  installChannelActionsContractSuite({
    plugin: mattermostPlugin,
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes send and react",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send", "react"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "reactions can be disabled while send stays available",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-token",
              baseUrl: "https://chat.example.com",
              actions: { reactions: false },
            },
          },
        } as OpenClawConfig,
        expectedActions: ["send"],
        expectedCapabilities: ["buttons"],
      },
      {
        name: "missing bot credentials disables the actions surface",
        cfg: {
          channels: {
            mattermost: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  });
});
