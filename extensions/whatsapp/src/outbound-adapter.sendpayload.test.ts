import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../src/test-utils/send-payload-contract.js";
import { whatsappOutbound } from "./outbound-adapter.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  const sendWhatsApp = vi.fn();
  primeSendMock(sendWhatsApp, { messageId: "wa-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "5511999999999@c.us",
    text: "",
    payload: params.payload,
    deps: {
      sendWhatsApp,
    },
  };
  return {
    run: async () => await whatsappOutbound.sendPayload!(ctx),
    sendMock: sendWhatsApp,
    to: ctx.to,
  };
}

describe("whatsappOutbound sendPayload", () => {
  installSendPayloadContractSuite({
    channel: "whatsapp",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness,
  });

  it("trims leading whitespace for direct text sends", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \thello",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "hello", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("trims leading whitespace for direct media captions", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendMedia!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \tcaption",
      mediaUrl: "/tmp/test.png",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "caption", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/test.png",
      mediaLocalRoots: undefined,
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("trims leading whitespace for sendPayload text and caption delivery", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n\nhello" },
      deps: { sendWhatsApp },
    });
    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n\ncaption", mediaUrl: "/tmp/test.png" },
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenNthCalledWith(1, "5511999999999@c.us", "hello", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
    });
    expect(sendWhatsApp).toHaveBeenNthCalledWith(2, "5511999999999@c.us", "caption", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/test.png",
      mediaLocalRoots: undefined,
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("skips whitespace-only text payloads", async () => {
    const sendWhatsApp = vi.fn();

    const result = await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n \t" },
      deps: { sendWhatsApp },
    });

    expect(result).toEqual({ channel: "whatsapp", messageId: "" });
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
