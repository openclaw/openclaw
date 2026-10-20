// Slack tests cover threading tool context plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const emptyCfg = {} as OpenClawConfig;

describe("buildSlackThreadingToolContext", () => {
  it("uses ReplyToId as the current thread when MessageThreadId is omitted", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        To: "user:U8SUVSVGS",
        NativeChannelId: "D8SRXRDNF",
        CurrentMessageId: "1772000000.111111",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("all");
    expect(result.sameChannelThreadRequired).toBe(true);
  });

  it("keeps top-level ReplyToId as an anchor without forcing configured off mode", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off" },
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "direct",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("off");
    expect(result.sameChannelThreadRequired).toBe(false);
  });

  it("uses CurrentMessageId as a non-explicit anchor when ReplyToId is omitted", () => {
    const result = buildSlackThreadingToolContext({
      cfg: {
        channels: {
          slack: {
            replyToMode: "first",
          },
        },
      } as OpenClawConfig,
      accountId: null,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1771999998.834199",
      },
    });

    expect(result.currentThreadTs).toBe("1771999998.834199");
    expect(result.replyToMode).toBe("first");
    expect(result.sameChannelThreadRequired).toBe(false);
  });

  it("keeps an Enterprise channel target workspace-qualified", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: {
        ChatType: "channel",
        To: "team:T123:channel:C1234ABC",
        NativeChannelId: "C1234ABC",
      },
    });

    expect(result.currentChannelId).toBe("team:T123:channel:C1234ABC");
    expect(result.currentMessagingTarget).toBe("team:T123:channel:C1234ABC");
  });

  it("uses the physical Enterprise DM channel without losing its workspace", () => {
    const result = buildSlackThreadingToolContext({
      cfg: emptyCfg,
      accountId: null,
      context: {
        ChatType: "direct",
        To: "team:T123:user:U8SUVSVGS",
        NativeChannelId: "D8SRXRDNF",
      },
    });

    expect(result.currentChannelId).toBe("team:T123:channel:D8SRXRDNF");
    expect(result.currentMessagingTarget).toBe("team:T123:user:U8SUVSVGS");
  });
});
