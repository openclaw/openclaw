import { describe, expect, it, vi } from "vitest";
import { signalPlugin } from "./channel.js";

describe("signal outbound cfg threading", () => {
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
});
