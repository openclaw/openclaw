import { expectDefined } from "@openclaw/normalization-core";
import { createSubscribedSessionHarness } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RequestClient } from "../internal/discord.js";

const sendDurableMessageBatchMock = vi.hoisted(() =>
  vi.fn<(params: DeliverParams) => Promise<unknown>>(),
);
const sendMessageDiscordMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").sendMessageDiscord>(),
);
const sendVoiceMessageDiscordMock = vi.hoisted(() =>
  vi.fn<typeof import("../send.js").sendVoiceMessageDiscord>(),
);

vi.mock("openclaw/plugin-sdk/channel-outbound", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  sendDurableMessageBatch: sendDurableMessageBatchMock,
}));

vi.mock("../send.js", async (original) => ({
  ...(await original<typeof import("../send.js")>()),
  sendMessageDiscord: sendMessageDiscordMock,
  sendVoiceMessageDiscord: sendVoiceMessageDiscordMock,
}));

let deliverDiscordReply: typeof import("./reply-delivery.js").deliverDiscordReply;

type DeliverParams = Record<string, unknown> & {
  cfg?: OpenClawConfig;
  formatting?: unknown;
  deps?: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const firstDeliverParams = () =>
  expectDefined(sendDurableMessageBatchMock.mock.calls[0]?.[0], "outbound batch");

const cfg: OpenClawConfig = { channels: { discord: { token: "test-token" } } };
const sentMessage = { messageId: "msg-1", channelId: "channel-1" };

const deliveryDefaults = {
  target: "channel:101",
  token: "token",
  cfg,
  textLimit: 2000,
  kind: "final" as const,
};
type ReplyOptions = Parameters<typeof deliverDiscordReply>[0];
const deliver = (replies: ReplyOptions["replies"], options: Partial<ReplyOptions> = {}) =>
  deliverDiscordReply({ ...deliveryDefaults, replies, ...options });

beforeAll(async () => {
  ({ deliverDiscordReply } = await import("./reply-delivery.js"));
});

beforeEach(() => {
  sendDurableMessageBatchMock.mockClear();
  sendDurableMessageBatchMock.mockResolvedValue({
    status: "sent",
    results: [sentMessage],
    receipt: createMessageReceiptFromOutboundResults({ results: [sentMessage] }),
  });
  sendMessageDiscordMock.mockReset().mockResolvedValue({
    ...sentMessage,
    receipt: createMessageReceiptFromOutboundResults({ results: [sentMessage] }),
  });
  sendVoiceMessageDiscordMock.mockReset().mockResolvedValue({
    messageId: "voice-1",
    channelId: "channel-1",
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ messageId: "voice-1", channelId: "channel-1" }],
    }),
  });
});

it.each([false, true])("bridges outbound Discord dependencies (voice=%s)", async (voice) => {
  const rest = {} as RequestClient;
  const body = voice ? "https://example.com/voice.ogg" : "probe";
  const replies = voice ? [{ mediaUrl: body, audioAsVoice: true }] : [{ text: body }];
  const onPlatformSendDispatch = vi.fn(async () => undefined);

  await deliver(replies, {
    accountId: "default",
    rest,
    replyToId: "reply-1",
    replyToMode: "all",
    allowedMentions: { parse: [] },
    onPlatformSendDispatch,
  });

  const params = firstDeliverParams();
  expect(params).toMatchObject({
    channel: "discord",
    to: "channel:101",
    accountId: "default",
    replyToId: "reply-1",
    replyToMode: "all",
    onPlatformSendDispatch,
  });
  expect(params.payloads).toEqual(replies);

  const sender = expectDefined(params.deps?.[voice ? "discordVoice" : "discord"], "sender");
  const reply = { messageId: "reply-1", scope: "all" };
  await sender("channel:101", body, voice ? { cfg, reply } : { verbose: false });
  const mock = voice ? sendVoiceMessageDiscordMock : sendMessageDiscordMock;
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "channel:101",
    body,
    expect.objectContaining({
      token: "token",
      ...(voice ? { reply } : { allowedMentions: { parse: [] } }),
    }),
  );
  const sendOptions = mock.mock.calls[0]![2];
  expect(sendOptions.cfg).toBe(params.cfg);
  expect(sendOptions.rest).toBe(rest);
});

it("delivers completed provider reasoning before a streamed answer block", async () => {
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "discord-reasoning-order",
    reasoningMode: "on",
    blockReplyBreak: "text_end",
    onBlockReply: async (payload) => {
      await deliver([payload], { kind: "block" });
    },
  });
  try {
    const thinking = { type: "thinking", thinking: "Because it helps" };
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [thinking] },
      assistantMessageEvent: { type: "thinking_end", content: "Because it helps" },
    });
    const message = {
      role: "assistant",
      content: [thinking, { type: "text", text: "Final answer" }],
    };
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Final answer" },
    });
    emit({ type: "message_end", message });
    await subscription.waitForPendingEvents();
    const batches = sendDurableMessageBatchMock.mock.calls;
    expect(batches.map(([params]) => params.payloads)).toMatchObject([
      [{ text: "Thinking\n\n_Because it helps_" }],
      [{ text: "Final answer" }],
    ]);
  } finally {
    subscription.unsubscribe();
  }
});

it("preserves the accepted receipt when a later Discord delivery fails", async () => {
  const cause = new Error("second Discord chunk failed");
  const receipt = createMessageReceiptFromOutboundResults({
    results: [
      { channel: "discord", messageId: "accepted-1" },
      { channel: "discord", messageId: "accepted-2" },
    ],
  });
  sendDurableMessageBatchMock.mockResolvedValueOnce({
    status: "partial_failed",
    results: [{ channel: "discord", messageId: "accepted-2", receipt }],
    receipt,
    error: cause,
    sentBeforeError: true,
  });

  const error = await deliver([{ text: "first chunk\nsecond chunk" }]).catch(
    (caught: unknown) => caught,
  );

  expect(isChannelPartialDeliveryError(error)).toBe(true);
  expect(error).toMatchObject({
    cause,
    sentBeforeError: true,
    visibleReplySent: true,
    deliveryResult: {
      messageIds: ["accepted-1", "accepted-2"],
      receipt,
      visibleReplySent: true,
    },
  });
});

it("preserves the original failure when Discord accepted no message", async () => {
  const cause = new Error("Discord send failed before acceptance");
  sendDurableMessageBatchMock.mockResolvedValueOnce({ status: "failed", error: cause });

  await expect(deliver([{ text: "not delivered" }])).rejects.toBe(cause);
});

it("fails when shared outbound accepts a final reply but delivers no Discord message", async () => {
  sendDurableMessageBatchMock.mockResolvedValueOnce({ status: "sent", results: [] });

  await expect(deliver([{ text: "lost reply" }], { accountId: "default" })).rejects.toThrow(
    "discord final reply produced no delivered message for channel:101",
  );
});

it("returns provider-owned hook suppression without inventing a Discord send", async () => {
  sendDurableMessageBatchMock.mockResolvedValueOnce({
    status: "suppressed",
    reason: "cancelled_by_message_sending_hook",
    payloadOutcomes: [
      {
        status: "suppressed",
        hookEffect: { cancelReason: "policy", metadata: { source: "test" } },
      },
    ],
  });

  await expect(deliver([{ text: "cancelled" }], { accountId: "default" })).resolves.toEqual({
    visibleReplySent: false,
    suppression: {
      reason: "cancelled_by_message_sending_hook",
      cancelReason: "policy",
      metadata: { source: "test" },
    },
  });
});

it("drops pure internal tool failure warnings at the final Discord send boundary", async () => {
  await deliver(
    [
      {
        text: "⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed",
        isError: true,
      },
    ],
    { accountId: "default" },
  );

  expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
});

const codeExample = ["Example:", "```", "🛠️ Exec: run ls", "```"].join("\n");
it.each<[string, ReplyOptions["replies"][number], string | undefined, ReplyOptions["kind"]?]>([
  [
    "strips assistant scaffolding from explicit tool progress",
    {
      text: '<think>private reasoning</think>\n<tool_call>{"name":"x"}</tool_call>\n🛠️ run git status',
    },
    "🛠️ run git status",
    "tool",
  ],
  [
    "preserves components when text scrubs empty",
    {
      text: `analysis: internal only
🛠️ run git status
📖 Read: lines 1-40 from secret.md
[tool:exec]
<parameter=command>
cat /proc/mounts
</parameter>
<function=exec>
<parameter=command>
find /tmp -type f
</parameter>
</function>`,
      channelData: {
        discord: {
          components: [
            { type: 1, components: [{ type: 2, style: 1, label: "Open", custom_id: "open" }] },
          ],
        },
      },
    },
    undefined,
  ],
  [
    "preserves presentation when text scrubs empty",
    {
      text: "commentary: hidden",
      presentation: {
        title: "Action required",
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Approve", value: "approve", style: "primary" as const }],
          },
        ],
      },
    },
    undefined,
  ],
  ["preserves code-fenced examples of tool-call labels", { text: codeExample }, codeExample],
])("%s", async (_name, payload, text, kind = "final") => {
  await deliver([payload], { accountId: "default", kind });
  expect(firstDeliverParams().payloads).toEqual([{ ...payload, text }]);
});

it("passes media roots and explicit off-mode payload reply tags to shared outbound", async () => {
  const replies = [{ text: "explicit reply", replyToId: "reply-explicit-1", replyToTag: true }];

  await deliver(replies, {
    target: "channel:202",
    replyToMode: "off",
    mediaLocalRoots: ["/tmp/openclaw-media"],
  });

  const params = firstDeliverParams();
  expect(params.payloads).toEqual(replies);
  expect(params).toMatchObject({
    replyToId: undefined,
    replyToMode: "off",
    mediaAccess: { localRoots: ["/tmp/openclaw-media"] },
  });
});

it("rewrites bound thread replies to parent target plus thread id and persona", async () => {
  const threadBindings = {
    listBySessionKey: vi.fn(() => [
      {
        accountId: "default",
        channelId: "parent-1",
        threadId: "thread-1",
        agentId: "main",
        label: `${"a".repeat(76)}🚀tail`,
      },
    ]),
  };

  await deliver([{ text: "Hello from subagent" }], {
    target: "channel:thread-1",
    accountId: "default",
    replyToId: "reply-1",
    sessionKey: "agent:main:subagent:child",
    threadBindings,
  });

  const params = firstDeliverParams();
  expect(params).toMatchObject({
    to: "channel:parent-1",
    threadId: "thread-1",
    replyToId: "reply-1",
    identity: { name: `🤖 ${"a".repeat(76)}` },
    session: { key: "agent:main:subagent:child", agentId: "main" },
  });
});
