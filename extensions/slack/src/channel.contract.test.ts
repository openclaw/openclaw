import type { OpenClawConfig } from "openclaw/plugin-sdk/slack";
import { describe } from "vitest";
import { installChannelActionsContractSuite } from "../../../src/test-utils/channel-actions-contract.js";
import { installChannelPluginContractSuite } from "../../../src/test-utils/channel-plugin-contract.js";
import { slackPlugin } from "./channel.js";

describe("slackPlugin contract", () => {
  installChannelPluginContractSuite({
    plugin: slackPlugin,
  });

  installChannelActionsContractSuite({
    plugin: slackPlugin,
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes default Slack actions",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks"],
      },
      {
        name: "interactive replies add the shared interactive capability",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: {
                interactiveReplies: true,
              },
            },
          },
        } as OpenClawConfig,
        expectedActions: [
          "send",
          "react",
          "reactions",
          "read",
          "edit",
          "delete",
          "download-file",
          "pin",
          "unpin",
          "list-pins",
          "member-info",
          "emoji-list",
        ],
        expectedCapabilities: ["blocks", "interactive"],
      },
      {
        name: "missing tokens disables the actions surface",
        cfg: {
          channels: {
            slack: {
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
