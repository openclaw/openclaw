// Slack tests cover channel.message adapter plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

describe("slack channel message adapter", () => {
  const sendSlack = vi.fn();

  function expectLastSendSlackCall(): [string, string, Record<string, unknown>] {
    const call = sendSlack.mock.calls.at(-1) as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    if (!call) {
      throw new Error("Expected sendSlack to be called");
    }
    return call;
  }

  beforeEach(() => {
    sendSlack.mockReset();
    sendSlack.mockResolvedValue({ messageId: "msg-1", channelId: "C123" });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = slackPlugin.message!;
    const sendText = adapter.send!.text!;
    const sendMedia = adapter.send!.media!;
    const sendPayload = adapter.send!.payload!;
    expect(adapter.durableFinal?.reconcileUnknownSendKinds).toEqual({ text: true });

    const proveText = async () => {
      sendSlack.mockClear();
      const onPlatformSendDispatch = vi.fn();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "hello",
        accountId: "default",
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("hello");
      expect(options.accountId).toBe("default");
      expect(options.deliveryQueueId).toBe("queue-1");
      expect(options.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      sendSlack.mockClear();
      const onPlatformSendDispatch = vi.fn();
      const result = await sendMedia({
        cfg,
        to: "C123",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("caption");
      expect(options.accountId).toBe("default");
      expect(options.mediaUrl).toBe("https://example.com/a.png");
      expect(options.mediaLocalRoots).toEqual(["/tmp/media"]);
      expect(options.deliveryQueueId).toBeUndefined();
      expect(options.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      sendSlack.mockClear();
      const onPlatformSendDispatch = vi.fn();
      const result = await sendPayload({
        cfg,
        to: "C123",
        text: "payload",
        payload: { text: "payload" },
        accountId: "default",
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("payload");
      expect(options.accountId).toBe("default");
      expect(options.deliveryQueueId).toBeUndefined();
      expect(options.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    };

    const proveReplyThread = async () => {
      sendSlack.mockClear();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "threaded",
        accountId: "default",
        replyToId: "1712000000.000001",
        threadId: "1712345678.123456",
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("threaded");
      expect(options.accountId).toBe("default");
      expect(options.threadTs).toBe("1712000000.000001");
      expect(result.receipt.replyToId).toBe("1712000000.000001");
    };

    const proveThreadFallback = async () => {
      sendSlack.mockClear();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "threaded",
        accountId: "default",
        threadId: "1712345678.123456",
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("threaded");
      expect(options.accountId).toBe("default");
      expect(options.threadTs).toBe("1712345678.123456");
      expect(result.receipt.threadId).toBe("1712345678.123456");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "slackMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        replyTo: proveReplyThread,
        thread: proveThreadFallback,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
        reconcileUnknownSend: () => {
          expect(adapter.durableFinal?.reconcileUnknownSend).toBeTypeOf("function");
        },
      },
    });
  });

  it("renders portable presentations through the facade as card receipts (#95440)", async () => {
    sendSlack.mockResolvedValueOnce({
      messageId: "msg-1",
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId: "msg-1", channelId: "C123" }],
        kind: "card",
      }),
    });
    const outbound = slackPlugin.outbound;
    const renderPresentation = outbound?.renderPresentation;
    if (!renderPresentation) {
      throw new Error("Expected Slack presentation renderer");
    }
    expect(outbound.presentationCapabilities).toBe(SLACK_PRESENTATION_CAPABILITIES);

    const presentation = {
      title: "Status",
      blocks: [{ type: "divider" as const }],
    };
    const payload = { text: "Fallback", presentation };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: { cfg, to: "C123", text: payload.text, payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack presentation payload");
    }
    // Core consumes the portable presentation before handing the native payload to the adapter.
    const { presentation: _presentation, ...deliveryPayload } = rendered;

    const result = await slackPlugin.message!.send!.payload!({
      cfg,
      to: "C123",
      text: deliveryPayload.text ?? "",
      payload: deliveryPayload,
      accountId: "default",
      deps: { sendSlack },
    });

    const [to, text, options] = expectLastSendSlackCall();
    expect(to).toBe("C123");
    expect(text).toBe("Fallback\n\nStatus");
    expect(options.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Fallback", verbatim: true },
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Status", emoji: true },
      },
      { type: "divider" },
    ]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });
});
