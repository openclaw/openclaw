import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

describe("signalPlugin outbound sendMedia", () => {
  it("forwards mediaLocalRoots to sendMessageSignal", async () => {
    const sendSignal = vi.fn(async () => ({ messageId: "m1" }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const sendMedia = signalPlugin.outbound?.sendMedia;
    if (!sendMedia) {
      throw new Error("signal outbound sendMedia is unavailable");
    }

    await sendMedia({
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
  });
});

describe("signalPlugin actions", () => {
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
