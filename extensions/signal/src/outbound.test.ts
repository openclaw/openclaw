import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

const sendMessageSignalMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMessageSignalMock(...args),
}));

import { signalOutbound } from "./outbound-adapter.js";

describe("signal outbound", () => {
  beforeEach(() => {
    sendMessageSignalMock.mockReset();
  });

  it("formats media captions and forwards mediaLocalRoots", async () => {
    sendMessageSignalMock.mockResolvedValueOnce({ messageId: "sig-media" });

    const result = await signalOutbound.sendFormattedMedia!({
      cfg: {} as never,
      to: "signal:+15551234567",
      text: "**bold** caption",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(sendMessageSignalMock).toHaveBeenCalledWith(
      "signal:+15551234567",
      "bold caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "default",
        textMode: "plain",
        textStyles: [{ start: 0, length: 4, style: "BOLD" }],
      }),
    );
    expect(result).toEqual({ channel: "signal", messageId: "sig-media" });
  });

  it("formats markdown text into plain Signal chunks with styles", async () => {
    sendMessageSignalMock.mockResolvedValue({ messageId: "sig-text" });

    const result = await signalOutbound.sendFormattedText!({
      cfg: {} as never,
      to: "signal:+15557654321",
      text: "hi _there_ **boss**",
      accountId: "default",
    });

    expect(sendMessageSignalMock).toHaveBeenCalledTimes(1);
    expect(sendMessageSignalMock).toHaveBeenCalledWith(
      "signal:+15557654321",
      "hi there boss",
      expect.objectContaining({
        accountId: "default",
        textMode: "plain",
        textStyles: [
          { start: 3, length: 5, style: "ITALIC" },
          { start: 9, length: 4, style: "BOLD" },
        ],
      }),
    );
    expect(result).toEqual([{ channel: "signal", messageId: "sig-text" }]);
  });

  it("threads provided cfg into sendText deps call", async () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            work: {
              mediaMaxMb: 12,
            },
          },
          mediaMaxMb: 5,
        },
      },
    };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-1" }));

    const result = await signalPlugin.outbound!.sendText!({
      cfg,
      to: "+15551230000",
      text: "hello",
      accountId: "work",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15551230000", "hello", {
      cfg,
      maxBytes: 12 * 1024 * 1024,
      accountId: "work",
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-1" });
  });

  it("threads cfg + mediaUrl into sendMedia deps call", async () => {
    const cfg = {
      channels: {
        signal: {
          mediaMaxMb: 7,
        },
      },
    };
    const sendSignal = vi.fn(async () => ({ messageId: "sig-2" }));

    const result = await signalPlugin.outbound!.sendMedia!({
      cfg,
      to: "+15559870000",
      text: "photo",
      mediaUrl: "https://example.com/a.jpg",
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith("+15559870000", "photo", {
      cfg,
      mediaUrl: "https://example.com/a.jpg",
      maxBytes: 7 * 1024 * 1024,
      accountId: "default",
    });
    expect(result).toEqual({ channel: "signal", messageId: "sig-2" });
  });

  it("forwards mediaLocalRoots to sendMedia deps", async () => {
    const sendSignal = vi.fn(async () => ({ messageId: "m1" }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const sendMedia = signalPlugin.outbound?.sendMedia;
    if (!sendMedia) {
      throw new Error("signal outbound sendMedia is unavailable");
    }

    const result = await sendMedia({
      cfg: {} as never,
      to: "signal:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "signal:+15551234567",
      "photo",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
      }),
    );
    expect(result).toEqual({ channel: "signal", messageId: "m1" });
  });

  it("owns unified message tool discovery", () => {
    const discovery = signalPlugin.actions?.describeMessageTool?.({
      cfg: {
        channels: {
          signal: {
            actions: { reactions: false },
            accounts: {
              work: { account: "+15550001111", actions: { reactions: true } },
            },
          },
        },
      } as never,
    });

    expect(discovery?.actions).toEqual(["send", "react"]);
  });
});
