const privateSourceTarget = {
  tool: "message",
  provider: "discord",
  to: "dm:U123",
  accountId: "acct-1",
  sourceReplyFinal: true,
};
const privateSourceFinal = {
  payloads: [{ text: "NO_REPLY" }],
  didSendViaMessagingTool: true,
  messagingToolSentTargets: [privateSourceTarget],
};

export const privateCompletionCases = [
  { name: "private text", result: { payloads: [{ text: "private parent review" }] } },
  { name: "media", result: { payloads: [{ mediaUrl: "https://example.com/private.png" }] } },
  {
    name: "source final",
    result: privateSourceFinal,
    recordsVisibleFinal: true,
  },
  {
    name: "source progress only",
    result: {
      ...privateSourceFinal,
      messagingToolSentTargets: [{ ...privateSourceTarget, sourceReplyFinal: false }],
    },
  },

  {
    name: "off-target final",
    result: {
      ...privateSourceFinal,
      messagingToolSentTargets: [{ ...privateSourceTarget, to: "dm:OTHER" }],
    },
  },
  {
    name: "source final before re-yield",
    result: { ...privateSourceFinal, meta: { yielded: true } },
  },
  {
    name: "source final before pending continuation",
    result: { ...privateSourceFinal, meta: { continuationPending: true } },
  },
  {
    name: "nested parent source final",
    result: privateSourceFinal,
    params: {
      requesterIsSubagent: true,
      requesterSessionKey: "agent:main:subagent:parent",
    },
  },
  {
    name: "source final without captured channel",
    result: privateSourceFinal,
    params: { origin: { to: "dm:U123", accountId: "acct-1" } },
  },
  {
    name: "source final without captured target",
    result: privateSourceFinal,
    params: { origin: { channel: "discord", accountId: "acct-1" } },
  },
];
