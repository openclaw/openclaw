import type { OpenClawConfig } from "openclaw/plugin-sdk/telegram";
import { afterEach, describe, vi } from "vitest";
import { installChannelActionsContractSuite } from "../../../src/test-utils/channel-actions-contract.js";
import { installChannelPluginContractSuite } from "../../../src/test-utils/channel-plugin-contract.js";

const telegramListActionsMock = vi.fn();
const telegramGetCapabilitiesMock = vi.fn();

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    channel: {
      telegram: {
        messageActions: {
          listActions: telegramListActionsMock,
          getCapabilities: telegramGetCapabilitiesMock,
        },
      },
    },
  }),
}));

const { telegramPlugin } = await import("./channel.js");

describe("telegramPlugin contract", () => {
  afterEach(() => {
    telegramListActionsMock.mockReset();
    telegramGetCapabilitiesMock.mockReset();
  });

  installChannelPluginContractSuite({
    plugin: telegramPlugin,
  });

  installChannelActionsContractSuite({
    plugin: telegramPlugin,
    cases: [
      {
        name: "forwards runtime-backed Telegram actions and capabilities",
        cfg: {} as OpenClawConfig,
        expectedActions: ["send", "poll", "react"],
        expectedCapabilities: ["interactive", "buttons"],
        beforeTest: () => {
          telegramListActionsMock.mockReturnValue(["send", "poll", "react"]);
          telegramGetCapabilitiesMock.mockReturnValue(["interactive", "buttons"]);
        },
      },
    ],
  });
});
