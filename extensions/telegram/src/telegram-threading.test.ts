import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { telegramThreading } from "./telegram-threading.js";

describe("telegramThreading", () => {
  it("honors per-account replyToMode overrides", () => {
    const resolveReplyToMode = telegramThreading.scopedAccountReplyToMode.resolveReplyToMode;

    const cfg = {
      channels: {
        telegram: {
          replyToMode: "all",
          botToken: "token-default",
          accounts: {
            work: {
              botToken: "token-work",
              replyToMode: "first",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveReplyToMode(telegramThreading.scopedAccountReplyToMode.resolveAccount(cfg, "work")),
    ).toBe("first");
    expect(
      resolveReplyToMode(telegramThreading.scopedAccountReplyToMode.resolveAccount(cfg, "default")),
    ).toBe("all");
  });

  it("keeps current DM topic threadId even when replyToId is present", () => {
    const resolved = telegramThreading.resolveAutoThreadId({
      to: "telegram:1234",
      toolContext: {
        currentChannelId: "telegram:1234",
        currentThreadTs: "533274",
      },
    });

    expect(resolved).toBe("533274");
  });

  it("does not override an explicit target topic when replyToId is present", () => {
    const resolved = telegramThreading.resolveAutoThreadId({
      to: "telegram:-1001:topic:99",
      toolContext: {
        currentChannelId: "telegram:-1001:topic:77",
        currentThreadTs: "77",
      },
    });

    expect(resolved).toBeUndefined();
  });
});
