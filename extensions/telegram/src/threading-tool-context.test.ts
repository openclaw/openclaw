import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";

const tryReadSecretFileSyncMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("reply mode must not read Telegram credentials");
  }),
);

vi.mock("openclaw/plugin-sdk/secret-file-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-file-runtime")>()),
  tryReadSecretFileSync: tryReadSecretFileSyncMock,
}));

describe("telegramPlugin reply threading", () => {
  it.each([
    [
      "first",
      {
        accounts: { sut: { tokenFile: "/tmp/must-not-read", replyToMode: "first" } },
      },
    ],
    [
      "all",
      {
        replyToMode: "all",
        accounts: {
          sut: {
            botToken: { source: "file", provider: "telegram_token", id: "value" },
          },
        },
      },
    ],
    [
      "off",
      {
        replyToMode: "all",
        accounts: { sut: { replyToMode: "off" } },
      },
    ],
  ] satisfies [string, NonNullable<OpenClawConfig["channels"]>["telegram"]][])(
    "resolves reply mode %s without reading credentials",
    (expected, telegram) => {
      tryReadSecretFileSyncMock.mockClear();
      const cfg: OpenClawConfig = { channels: { telegram } };
      expect(telegramPlugin.threading?.resolveReplyToMode?.({ cfg, accountId: "sut" })).toBe(
        expected,
      );
      expect(tryReadSecretFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["-100123", "telegram:-100123", true],
    ["telegram:-100123", "-100123", true],
    ["-100123:topic:77", "telegram:-100123:77", true],
    ["1234:topic:77", "telegram:1234:topic:77", true],
    ["1234:topic:77", "telegram:1234:topic:78", false],
    ["-100123:direct-topic:77", "telegram:-100123:direct-topic:77", true],
    ["-100123:direct-topic:77", "telegram:-100123:direct-topic:78", false],
    ["-100123:topic:77", "telegram:-100123:direct-topic:77", false],
    ["-100123:topic:77", "telegram:-100123:topic:78", false],
    ["-100456", "telegram:-100123", false],
  ] as const)(
    "matches canonical target %s against current channel %s: %s",
    (target, currentChannelId, expected) => {
      expect(
        telegramPlugin.threading?.matchesToolContextTarget?.({
          target,
          toolContext: { currentChannelId },
        }),
      ).toBe(expected);
    },
  );

  it("recovers missing thread metadata from the target only for the same chat", () => {
    const cfg: OpenClawConfig = {};
    const toolContext = telegramPlugin.threading?.buildToolContext?.({
      cfg,
      accountId: "default",
      context: { To: "telegram:-1001:topic:77", CurrentMessageId: "msg-1" },
    });
    expect(
      telegramPlugin.threading?.resolveAutoThreadId?.({ cfg, to: "telegram:-1001", toolContext }),
    ).toBe("77");
    expect(
      telegramPlugin.threading?.resolveAutoThreadId?.({ cfg, to: "telegram:-1002", toolContext }),
    ).toBeUndefined();
  });

  it.each([
    ["telegram:1234", "telegram:1234", "533274", "533274"],
    ["telegram:-1001:topic:99", "telegram:-1001:topic:77", "77", undefined],
  ] as const)(
    "respects the registered thread selection for %s",
    (to, currentChannelId, currentThreadTs, expected) => {
      expect(
        telegramPlugin.threading?.resolveAutoThreadId?.({
          cfg: {},
          to,
          toolContext: { currentChannelId, currentThreadTs },
        }),
      ).toBe(expected);
    },
  );
});
