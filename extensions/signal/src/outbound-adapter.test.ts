import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSignalMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMessageSignalMock(...args),
}));

import { signalOutbound } from "./outbound-adapter.js";

describe("signalOutbound", () => {
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
});
