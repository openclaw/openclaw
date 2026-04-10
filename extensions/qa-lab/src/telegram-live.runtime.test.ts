import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { __testing } from "./telegram-live.runtime.js";

describe("telegram live qa runtime", () => {
  it("resolves required Telegram QA env vars", () => {
    expect(
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut",
      }),
    ).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
  });

  it("fails when a required Telegram QA env var is missing", () => {
    expect(() =>
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
      }),
    ).toThrow("OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN");
  });

  it("fails when the Telegram group id is not numeric", () => {
    expect(() =>
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "qa-group",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut",
      }),
    ).toThrow("OPENCLAW_QA_TELEGRAM_GROUP_ID must be a numeric Telegram chat id.");
  });

  it("injects a temporary Telegram account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };

    const next = __testing.buildTelegramQaConfig(baseCfg, {
      groupId: "-100123",
      sutToken: "sut-token",
      driverBotId: 42,
      sutAccountId: "sut",
    });

    expect(next.plugins?.allow).toContain("telegram");
    expect(next.plugins?.entries?.telegram).toEqual({ enabled: true });
    expect(next.channels?.telegram).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          enabled: true,
          botToken: "sut-token",
          dmPolicy: "disabled",
          groups: {
            "-100123": {
              groupPolicy: "allowlist",
              allowFrom: ["42"],
              requireMention: true,
            },
          },
        },
      },
    });
  });

  it("normalizes observed Telegram messages", () => {
    expect(
      __testing.normalizeTelegramObservedMessage({
        update_id: 7,
        message: {
          message_id: 9,
          date: 1_700_000_000,
          text: "hello",
          chat: { id: -100123 },
          from: {
            id: 42,
            is_bot: true,
            username: "driver_bot",
          },
          reply_to_message: { message_id: 8 },
          reply_markup: {
            inline_keyboard: [[{ text: "Approve" }, { text: "Deny" }]],
          },
          photo: [{}],
        },
      }),
    ).toEqual({
      updateId: 7,
      messageId: 9,
      chatId: -100123,
      senderId: 42,
      senderIsBot: true,
      senderUsername: "driver_bot",
      text: "hello",
      caption: undefined,
      replyToMessageId: 8,
      timestamp: 1_700_000_000_000,
      inlineButtons: ["Approve", "Deny"],
      mediaKinds: ["photo"],
    });
  });

  it("formats phase-specific canary diagnostics with context", () => {
    const error = new Error(
      "SUT bot did not send any group reply after the canary command within 30s.",
    );
    error.name = "TelegramQaCanaryError";
    Object.assign(error, {
      phase: "sut_reply_timeout",
      context: {
        driverMessageId: 55,
        sutBotId: 88,
      },
    });

    const message = __testing.canaryFailureMessage({
      error,
      groupId: "-100123",
      driverBotId: 42,
      driverUsername: "driver_bot",
      sutBotId: 88,
      sutUsername: "sut_bot",
    });
    expect(message).toContain("Phase: sut_reply_timeout");
    expect(message).toContain("- driverMessageId: 55");
    expect(message).not.toContain("- sutBotId: 88\n- sutBotId: 88");
    expect(message).toContain(
      "Confirm the SUT bot is present in the target private group and can receive /help@BotUsername commands there.",
    );
  });
});
