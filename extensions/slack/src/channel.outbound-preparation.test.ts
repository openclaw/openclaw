import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig, SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackSend = typeof import("./send.js").sendMessageSlack;
const outbound = slackPlugin.outbound!;
function context(
  account: SlackAccountConfig = { mode: "http", postAs: "user", userToken: "test-user-token" },
) {
  const cfg: OpenClawConfig = { channels: { slack: { accounts: { work: account } } } };
  return { cfg, accountId: "work", to: "channel:C123", text: "hello", payload: { text: "hello" } };
}
function sender() {
  let part = 0;
  return vi.fn<SlackSend>(async (_to, _text, options) => {
    await options.onPlatformSendDispatch?.();
    const messageId = `171.00${++part}`;
    const result = {
      messageId,
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId }],
        kind: options.mediaUrl ? "media" : "text",
      }),
    };
    await options.onDeliveryResult?.(result);
    return result;
  });
}

function fixture(account?: SlackAccountConfig) {
  const ctx = context(account);
  const nativeSend = sender();
  const deps = { slack: nativeSend };
  const payload = (
    options: Partial<Parameters<NonNullable<typeof outbound.sendPayload>>[0]> = {},
  ) => outbound.sendPayload!({ ...ctx, deps, ...options });
  return { ctx, nativeSend, deps, payload };
}

it("preserves media credentials, custody and receipts with reply precedence", async () => {
  const { ctx, nativeSend, deps } = fixture();
  const originalConfig = structuredClone(ctx.cfg);
  const order: string[] = [];
  const progress: OutboundDeliveryResult[] = [];
  const result = await outbound.sendMedia!({
    ...ctx,
    mediaUrl: "https://example.invalid/image.png",
    deliveryQueueId: "queue-1",
    replyToId: "1712000000.000001",
    threadId: "1712345678.123456",
    deps,
    onPlatformSendDispatch: async () => {
      order.push("dispatch");
    },
    onDeliveryResult: (delivery) => {
      order.push("receipt");
      progress.push(delivery);
    },
  });
  expect(nativeSend).toHaveBeenCalledOnce();
  const options = nativeSend.mock.calls[0]![2];
  expect(options.cfg).toBe(ctx.cfg);
  expect(options).toMatchObject({
    accountId: "work",
    token: "test-user-token",
    threadTs: "1712000000.000001",
  });
  expect(options.deliveryQueueId).toBeUndefined();
  expect(order).toEqual(["dispatch", "receipt"]);
  const delivery = {
    channel: "slack",
    messageId: "171.001",
    target: { kind: "channel", id: "C123" },
  };
  expect(progress).toMatchObject([delivery]);
  expect(result).toMatchObject({
    ...delivery,
    receipt: { platformMessageIds: ["171.001"] },
  });
  expect(ctx.cfg).toEqual(originalConfig);
});

it("rejects active SecretRefs before an injected send", async () => {
  const { payload, nativeSend } = fixture({
    mode: "http",
    botToken: { source: "exec", provider: "default", id: "fixture-slack-token" },
  });
  await expect(payload()).rejects.toThrow("channels.slack.accounts.work.botToken");
  expect(nativeSend).not.toHaveBeenCalled();
});

it("rejects bare Enterprise targets before an injected send", async () => {
  const { payload, nativeSend } = fixture();
  const installation = registerSlackInstallationState("work", "enterprise");
  try {
    await expect(payload()).rejects.toThrow("unsupported_enterprise_slack_delivery");
    expect(nativeSend).not.toHaveBeenCalled();
  } finally {
    installation.release();
  }
});

it("consumes an implicit first-mode fallback thread once across media fanout", async () => {
  const { payload, nativeSend } = fixture();
  const progress: OutboundDeliveryResult[] = [];
  const result = await payload({
    payload: {
      text: "caption",
      mediaUrls: ["https://example.invalid/1.png", "https://example.invalid/2.png"],
    },
    replyToId: "internal-message-id",
    threadId: "1712345678.123456",
    replyToMode: "first",
    replyToIdSource: "implicit",
    onDeliveryResult: (delivery) => {
      progress.push(delivery);
    },
  });
  expect(nativeSend.mock.calls.map(([, text, options]) => [text, options.threadTs])).toEqual([
    ["caption", "1712345678.123456"],
    ["", undefined],
  ]);
  expect(progress.map(({ messageId }) => messageId)).toEqual(["171.001", "171.002"]);
  expect(result).toMatchObject({ channel: "slack", messageId: "171.002" });
});

it("keeps the selected sender and write token throughout payload fanout", async () => {
  const account: SlackAccountConfig = {
    mode: "http",
    userToken: "test-first-token",
    userTokenReadOnly: false,
  };
  const { payload, nativeSend, deps } = fixture(account);
  const replacementSend = sender();
  const firstSend = nativeSend.getMockImplementation()!;
  nativeSend.mockImplementationOnce(async (...args) => {
    account.userToken = "test-replacement-token";
    deps.slack = replacementSend;
    return await firstSend(...args);
  });
  const result = await payload({
    payload: {
      text: "done",
      mediaUrls: ["https://example.invalid/image.png"],
      presentation: { blocks: [{ type: "divider" }] },
    },
  });
  expect(nativeSend.mock.calls.map((call) => call[2].token)).toEqual([
    "test-first-token",
    "test-first-token",
  ]);
  expect(replacementSend).not.toHaveBeenCalled();
  expect(result.receipt?.platformMessageIds).toEqual(["171.001", "171.002"]);
});
