import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createMessageReceiptFromOutboundResults,
  sendDurableMessageBatch,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

const sendZaloTextMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel.runtime.js")>()),
  sendMessageZalo: sendZaloTextMock,
}));

const required = <T>(value: T | undefined) => expectDefined(value, "Zalo outbound capability");

const zaloMessageAdapter = required(zaloPlugin.message);
const target = () => ({ cfg: {}, to: "123456789" });

function createZaloHarness(params: OutboundPayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(sendZalo, { messageId: "zl-1" }, params.sendResults);
  sendZaloTextMock
    .mockReset()
    .mockImplementation(
      async (to: string, text: string, nextCtx: { mediaUrl?: string }) =>
        await sendZalo(to, text, { mediaUrl: nextCtx.mediaUrl }),
    );
  const ctx = { ...target(), text: "", payload: params.payload };
  const sendPayload = required(zaloPlugin.outbound?.sendPayload);
  return {
    run: async () => await sendPayload(ctx),
    sendMock: sendZalo,
    to: ctx.to,
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Zalo outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });

  it.each([
    { kind: "text", payload: { text: "hello" } },
    {
      kind: "media",
      payload: { text: "image", mediaUrl: "https://example.com/image.png" },
    },
  ] as const)(
    "reports $kind message-adapter failures to durable delivery",
    async ({ kind, payload }) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "zalo", source: "test", plugin: zaloPlugin }]),
      );
      sendZaloTextMock.mockReset().mockRejectedValue(new Error(`Zalo rejected the ${kind}`));

      const result = await sendDurableMessageBatch({
        ...target(),
        channel: "zalo",
        payloads: [payload],
        skipQueue: true,
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") {
        throw new Error(`Expected failed Zalo ${kind} delivery`);
      }
      expect(result.error).toMatchObject({ message: `Zalo rejected the ${kind}` });
    },
  );

  it("declares message adapter durable text and media with receipt proofs", async () => {
    sendZaloTextMock
      .mockReset()
      .mockImplementation(async (_to: string, _text: string, ctx: { mediaUrl?: string }) => {
        const kind = ctx.mediaUrl ? "media" : "text";
        const messageId = `zl-${kind}-1`;
        return {
          messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "zalo", messageId }],
            kind,
          }),
        };
      });
    const sendText = required(zaloMessageAdapter.send?.text);
    const sendMedia = required(zaloMessageAdapter.send?.media);

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "zalo",
      adapter: zaloMessageAdapter,
      proofs: {
        text: async () => {
          const result = await sendText({ ...target(), text: "hello" });
          expect(result.receipt.platformMessageIds).toEqual(["zl-text-1"]);
        },
        media: async () => {
          const result = await sendMedia({
            ...target(),
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result.receipt.platformMessageIds).toEqual(["zl-media-1"]);
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
    expect(proofs).toStrictEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "verified" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});
