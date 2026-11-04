import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

type Context = Parameters<typeof buildSlackThreadingToolContext>[0]["context"];
function build(context: Context, slack?: NonNullable<OpenClawConfig["channels"]>["slack"]) {
  return buildSlackThreadingToolContext({ cfg: { channels: { slack } }, accountId: null, context });
}
const anchor = "1771999998.834199";
const direct = { replyToMode: "all", replyToModeByChatType: { direct: "off" } } as const;
it.each([
  {
    name: "explicit ReplyToId",
    context: {
      ChatType: "direct",
      To: "user:U8SUVSVGS",
      NativeChannelId: "D8SRXRDNF",
      CurrentMessageId: "1772000000.111111",
      ReplyToId: anchor,
    },
    config: direct,
    mode: "all",
    required: true,
  },
  {
    name: "top-level ReplyToId",
    context: { ChatType: "direct", CurrentMessageId: anchor, ReplyToId: anchor },
    config: direct,
    mode: "off",
    required: false,
  },
  {
    name: "CurrentMessageId without ReplyToId",
    context: { ChatType: "channel", To: "channel:C123", CurrentMessageId: anchor },
    config: { replyToMode: "first" } as const,
    mode: "first",
    required: false,
  },
])("uses $name with the appropriate reply mode", ({ context, config, mode, required }) => {
  expect(build(context, config)).toMatchObject({
    currentThreadTs: anchor,
    replyToMode: mode,
    sameChannelThreadRequired: required,
  });
});

it.each([
  {
    kind: "channel",
    to: "team:T123:channel:C1234ABC",
    native: "C1234ABC",
    channel: "team:T123:channel:C1234ABC",
  },
  {
    kind: "direct",
    to: "team:T123:user:U8SUVSVGS",
    native: "D8SRXRDNF",
    channel: "team:T123:channel:D8SRXRDNF",
  },
])("preserves the Enterprise workspace for $kind targets", ({ kind, to, native, channel }) => {
  expect(build({ ChatType: kind, To: to, NativeChannelId: native })).toMatchObject({
    currentChannelId: channel,
    currentMessagingTarget: to,
  });
});
