// Explicit target/thread cases for the Slack action boundary.
export const actionThreadTargetCases: Array<{
  name: string;
  to: string;
  currentChannelId: string;
  currentMessagingTarget?: string;
  replyToMode?: "all" | "first" | "off";
  patch?: { threadTs?: string | null; topLevel?: true };
  expectedThreadTs?: string;
}> = [
  {
    name: "matching channel",
    to: "channel:C123",
    currentChannelId: "C123",
    expectedThreadTs: "1111111111.111111",
  },
  {
    name: "matching DM user",
    to: "user:U123",
    currentChannelId: "slack:U123",
    expectedThreadTs: "1111111111.111111",
  },
  {
    name: "routable DM with native channel",
    to: "user:U123",
    currentChannelId: "D123",
    currentMessagingTarget: "user:U123",
    expectedThreadTs: "1111111111.111111",
  },
  {
    name: "topLevel true",
    to: "channel:C123",
    currentChannelId: "C123",
    patch: { topLevel: true },
  },
  {
    name: "threadTs null",
    to: "channel:C123",
    currentChannelId: "C123",
    patch: { threadTs: null },
  },
  {
    name: "first without reply reference",
    to: "#c123",
    currentChannelId: "C123",
    replyToMode: "first",
  },
  { name: "threading off", to: "channel:C123", currentChannelId: "C123", replyToMode: "off" },
  { name: "different channel", to: "channel:C999", currentChannelId: "C123" },
  {
    name: "explicit thread override",
    to: "channel:C123",
    currentChannelId: "C123",
    patch: { threadTs: "9999999999.999999" },
    expectedThreadTs: "9999999999.999999",
  },
  {
    name: "bare channel target",
    to: "C123",
    currentChannelId: "C123",
    expectedThreadTs: "1111111111.111111",
  },
];
