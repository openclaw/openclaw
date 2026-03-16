import type { OpenClawConfig } from "openclaw/plugin-sdk/discord";
import { afterEach, describe, vi } from "vitest";
import { installChannelActionsContractSuite } from "../../../src/test-utils/channel-actions-contract.js";
import { installChannelPluginContractSuite } from "../../../src/test-utils/channel-plugin-contract.js";

const discordListActionsMock = vi.fn();
const discordGetCapabilitiesMock = vi.fn();

vi.mock("./runtime.js", () => ({
  getDiscordRuntime: () => ({
    channel: {
      discord: {
        messageActions: {
          listActions: discordListActionsMock,
          getCapabilities: discordGetCapabilitiesMock,
        },
      },
    },
  }),
}));

const { discordPlugin } = await import("./channel.js");

describe("discordPlugin contract", () => {
  afterEach(() => {
    discordListActionsMock.mockReset();
    discordGetCapabilitiesMock.mockReset();
  });

  installChannelPluginContractSuite({
    plugin: discordPlugin,
  });

  installChannelActionsContractSuite({
    plugin: discordPlugin,
    cases: [
      {
        name: "forwards runtime-backed Discord actions and capabilities",
        cfg: {} as OpenClawConfig,
        expectedActions: ["send", "react", "poll"],
        expectedCapabilities: ["interactive", "components"],
        beforeTest: () => {
          discordListActionsMock.mockReturnValue(["send", "react", "poll"]);
          discordGetCapabilitiesMock.mockReturnValue(["interactive", "components"]);
        },
      },
    ],
  });
});
