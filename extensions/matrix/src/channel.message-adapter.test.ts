import {
  verifyChannelMessageAdapterCapabilityProofs,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({ sendMessageMatrix: vi.fn() }));

vi.mock("./matrix/send.js", () => ({
  editMessageMatrix: vi.fn(),
  reactMatrixMessage: vi.fn(),
  resolveMatrixRoomId: vi.fn(),
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: vi.fn(),
  sendTypingMatrix: vi.fn(),
}));

// mock-isolation: Adapter proofs use a synthetic runtime instead of the process runtime singleton.
vi.mock("./runtime.js", () => ({
  getOptionalMatrixRuntime: () => undefined,
  getMatrixRuntime: () => ({ channel: { text: { chunkMarkdownText: (text: string) => [text] } } }),
}));

import { matrixPlugin } from "./channel.js";

const cfg = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "resolved-token",
    },
  },
} as OpenClawConfig;

const sendContext = { cfg, to: "room:!room:example", accountId: "default" };
function lastMatrixSendOptions() {
  const options = mocks.sendMessageMatrix.mock.lastCall?.[2];
  if (!options || typeof options !== "object") {
    throw new Error("Expected Matrix send options");
  }
  return options as Record<string, unknown>;
}

function expectSend(text: string, options: Record<string, unknown>) {
  expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
  expect(mocks.sendMessageMatrix.mock.lastCall?.slice(0, 2)).toEqual(["room:!room:example", text]);
  expect(lastMatrixSendOptions().cfg).toBe(cfg);
  expect(lastMatrixSendOptions()).toMatchObject(options);
}

function sendProof<T extends { text: string }>(
  send: (input: NoInfer<T> & typeof sendContext) => Promise<ChannelMessageSendResult>,
  input: T,
  expectedReceipt: Record<string, unknown>,
) {
  return async () => {
    mocks.sendMessageMatrix.mockClear();
    const result = await send({ ...sendContext, ...input });
    const { text, ...options } = input;
    expectSend(text, { accountId: "default", ...options });
    expect(result.receipt).toMatchObject(expectedReceipt);
  };
}

describe("matrix channel message adapter", () => {
  const adapter = matrixPlugin.message;
  if (!adapter?.send?.text || !adapter.send.media) {
    throw new Error("Expected Matrix text and media senders");
  }
  const { text: sendText, media: sendMedia } = adapter.send;
  beforeAll(async () => {
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$warmup", roomId: "!room:example" });
    await sendText({ ...sendContext, text: "warmup" });
  });

  it("keeps all owner-provided Matrix receipt parts across the message adapter boundary", async () => {
    const receipt = {
      primaryPlatformMessageId: "$image",
      platformMessageIds: ["$image", "$overflow"],
      parts: [
        { platformMessageId: "$image", kind: "media" as const, index: 0, replyToId: "$reply" },
        { platformMessageId: "$overflow", kind: "text" as const, index: 1 },
      ],
      replyToId: "$reply",
      sentAt: 1,
    };
    mocks.sendMessageMatrix.mockResolvedValueOnce({
      messageId: "$overflow",
      roomId: "!room:example",
      primaryMessageId: "$image",
      receipt,
      content: "image\noverflow",
    });

    const result = await sendMedia({
      ...sendContext,
      text: "image\noverflow",
      mediaUrl: "file:///tmp/photo.png",
      replyToId: "$reply",
    });

    expect(result.messageId).toBe("$overflow");
    expect(result.receipt).toBe(receipt);
    expect(result.receipt.primaryPlatformMessageId).toBe("$image");
    expect(result.receipt.platformMessageIds).toEqual(["$image", "$overflow"]);
    expect(result.receipt.parts[1]).not.toHaveProperty("replyToId");
  });

  it("routes the standard Matrix send action through canonical durable delivery", async () => {
    const prepareSendPayload = matrixPlugin.actions?.prepareSendPayload;
    if (!prepareSendPayload) {
      throw new Error("Expected Matrix prepared-send adapter");
    }
    const payload = { text: "durable tool send" };

    expect(
      await prepareSendPayload({ ctx: { action: "send", cfg } as never, payload } as never),
    ).toBe(payload);
    expect(
      await prepareSendPayload({ ctx: { action: "edit", cfg } as never, payload } as never),
    ).toBeNull();
  });

  it.each([
    ["room:!room:example", "off", "$thread"],
    ["matrix:channel:!room:example", "all", "$thread"],
    ["room:!another:example", "all", undefined],
    ["user:@alice:example", "all", undefined],
  ] as const)(
    "routes a native Matrix message action to %s (%s)",
    async (to, replyToMode, expectedThreadId) => {
      const threading = matrixPlugin.threading;
      const handleAction = matrixPlugin.actions?.handleAction;
      if (!threading?.resolveAutoThreadId || !handleAction) {
        throw new Error("Expected Matrix threaded message action adapters");
      }
      const toolContext = {
        currentChannelProvider: "matrix" as const,
        currentChannelId: "room:!room:example",
        currentThreadTs: "$thread",
        currentMessageId: "$reply",
        replyToMode,
        hasRepliedRef: { value: true },
      };
      const threadId = threading.resolveAutoThreadId({
        cfg,
        accountId: "default",
        to,
        toolContext,
        replyToId: "$explicit-reply",
      });

      await handleAction({
        cfg,
        channel: "matrix",
        action: "send",
        accountId: "default",
        toolContext,
        params: {
          to,
          message: "threaded native action",
          replyTo: "$explicit-reply",
          ...(threadId ? { threadId } : {}),
        },
      });

      expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
      expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe(to);
      expect(lastMatrixSendOptions()).toMatchObject({
        cfg,
        accountId: "default",
        replyToId: "$explicit-reply",
        threadId: expectedThreadId,
      });
    },
  );

  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$event-1", roomId: "!room:example" });
  });

  it("backs declared durable-final capabilities with runtime outbound proofs", async () => {
    const proveText = sendProof(
      sendText,
      { text: "hello", deliveryQueueId: "queue-1", deliveryPartIndex: 2, deliveryPartCount: 3 },
      { platformMessageIds: ["$event-1"], parts: [{ kind: "text" }] },
    );
    const proveMedia = sendProof(
      sendMedia,
      {
        text: "caption",
        mediaUrl: "file:///tmp/cat.png",
        mediaLocalRoots: ["/tmp/openclaw"],
        audioAsVoice: true,
      },
      { parts: [{ kind: "voice" }] },
    );
    const proveReplyThread = sendProof(
      sendText,
      { text: "threaded", replyToId: "$reply", threadId: "$thread" },
      { replyToId: "$reply", threadId: "$thread" },
    );

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "matrixMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        replyTo: proveReplyThread,
        thread: proveReplyThread,
        messageSendingHooks: () => {
          expect(adapter.send?.text).toBeTypeOf("function");
        },
        afterCommit: () => {
          expect(adapter.send?.lifecycle?.afterCommit).toBeTypeOf("function");
        },
        reconcileUnknownSend: () => {
          expect(adapter.durableFinal?.reconcileUnknownSend).toBeTypeOf("function");
          expect(adapter.durableFinal?.afterUnknownSendTerminal).toBeTypeOf("function");
        },
      },
    });
  });

  it("forwards presentation payload hooks through the registered outbound adapter", async () => {
    const outbound = matrixPlugin.outbound;
    expect(outbound?.presentationCapabilities).toMatchObject({
      supported: true,
      buttons: true,
      selects: true,
      context: true,
      divider: true,
    });
    if (!outbound?.renderPresentation || !outbound.sendPayload) {
      throw new Error("Expected Matrix outbound presentation payload hooks.");
    }

    const presentation = {
      title: "Select thinking level",
      tone: "info" as const,
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Low", value: "/think low" }] }],
    };
    const extraContent = {
      "com.openclaw.presentation": { ...presentation, version: 1, type: "message.presentation" },
    };
    const rendered = await outbound.renderPresentation({
      payload: { text: "fallback", presentation },
      presentation,
      ctx: {} as never,
    });

    expect(rendered?.text).toContain("fallback");
    expect(rendered?.text).toContain("Select thinking level");

    expect(rendered?.channelData?.matrix).toEqual(expect.objectContaining({ extraContent }));

    await outbound.sendPayload({
      ...sendContext,
      text: rendered?.text ?? "",
      payload: rendered!,
      threadId: "$thread",
      replyToId: "$reply",
    });

    expectSend(rendered!.text!, { accountId: "default", threadId: "$thread", replyToId: "$reply" });
    expect(lastMatrixSendOptions().extraContent).toEqual(extraContent);
  });
});
