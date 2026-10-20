import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

type Context = Parameters<typeof buildSlackThreadingToolContext>[0]["context"];
function build(context: Context, slack?: NonNullable<OpenClawConfig["channels"]>["slack"]) {
  return buildSlackThreadingToolContext({ cfg: { channels: { slack } }, accountId: null, context });
}
const directConfig = { replyToMode: "all", replyToModeByChatType: { direct: "off" } } as const;

describe("buildSlackThreadingToolContext", () => {
  it("uses ReplyToId as the current thread when MessageThreadId is omitted", () => {
    const result = build(
      {
        ChatType: "direct",
        To: "user:U8SUVSVGS",
        NativeChannelId: "D8SRXRDNF",
        CurrentMessageId: "1772000000.111111",
        ReplyToId: "1771999998.834199",
      },
      directConfig,
    );
    expect(result).toMatchObject({
      currentThreadTs: "1771999998.834199",
      replyToMode: "all",
      sameChannelThreadRequired: true,
    });
  });

  it("keeps top-level ReplyToId as an anchor without forcing configured off mode", () => {
    const result = build(
      {
        ChatType: "direct",
        CurrentMessageId: "1771999998.834199",
        ReplyToId: "1771999998.834199",
      },
      directConfig,
    );
    expect(result).toMatchObject({
      currentThreadTs: "1771999998.834199",
      replyToMode: "off",
      sameChannelThreadRequired: false,
    });
  });

  it("uses CurrentMessageId as a non-explicit anchor when ReplyToId is omitted", () => {
    const result = build(
      {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1771999998.834199",
      },
      { replyToMode: "first" },
    );
    expect(result).toMatchObject({
      currentThreadTs: "1771999998.834199",
      replyToMode: "first",
      sameChannelThreadRequired: false,
    });
  });

  it("keeps an Enterprise channel target workspace-qualified", () => {
    const result = build({
      ChatType: "channel",
      To: "team:T123:channel:C1234ABC",
      NativeChannelId: "C1234ABC",
    });
    expect(result.currentChannelId).toBe("team:T123:channel:C1234ABC");
    expect(result.currentMessagingTarget).toBe("team:T123:channel:C1234ABC");
  });

  it("uses the physical Enterprise DM channel without losing its workspace", () => {
    const result = build({
      ChatType: "direct",
      To: "team:T123:user:U8SUVSVGS",
      NativeChannelId: "D8SRXRDNF",
    });
    expect(result.currentChannelId).toBe("team:T123:channel:D8SRXRDNF");
    expect(result.currentMessagingTarget).toBe("team:T123:user:U8SUVSVGS");
  });
});
