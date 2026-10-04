// Slack tests cover action runtime account gate plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";

describe("handleSlackAction account gates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps top-level action gates the account did not override", async () => {
    vi.spyOn(slackActionRuntime, "resolveSlackConversationInfo").mockResolvedValue({
      type: "channel",
    });
    const listSlackPins = vi.spyOn(slackActionRuntime, "listSlackPins").mockResolvedValue([]);
    const reactSlackMessage = vi
      .spyOn(slackActionRuntime, "reactSlackMessage")
      .mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          botToken: "tok",
          actions: { messages: false, pins: false },
          accounts: {
            work: {
              botToken: "xoxb-work",
              actions: { reactions: true },
            },
          },
        },
      },
    };

    await expect(
      handleSlackAction({ action: "listPins", channelId: "C1", accountId: "work" }, cfg),
    ).rejects.toThrow(/Slack pins are disabled/);
    expect(listSlackPins).not.toHaveBeenCalled();

    await handleSlackAction(
      { action: "react", channelId: "C1", messageId: "123.456", emoji: "✅", accountId: "work" },
      cfg,
    );
    expect(reactSlackMessage).toHaveBeenCalled();
  });
});
