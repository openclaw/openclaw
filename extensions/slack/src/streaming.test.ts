import { describe, expect, it, vi } from "vitest";
import { stopSlackStream } from "./streaming.js";

describe("stopSlackStream", () => {
  it("marks the session as stopped and calls streamer.stop", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const session = {
      streamer: { stop } as never,
      channel: "C001",
      threadTs: "123.456",
      stopped: false,
    };

    await stopSlackStream({ session });

    expect(stop).toHaveBeenCalledWith(undefined);
    expect(session.stopped).toBe(true);
  });

  it("passes final markdown_text when text is provided", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const session = {
      streamer: { stop } as never,
      channel: "C001",
      threadTs: "123.456",
      stopped: false,
    };

    await stopSlackStream({ session, text: "Final message" });

    expect(stop).toHaveBeenCalledWith({ markdown_text: "Final message" });
    expect(session.stopped).toBe(true);
  });

  it("does not re-call stop when already stopped (idempotent)", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const session = {
      streamer: { stop } as never,
      channel: "C001",
      threadTs: "123.456",
      stopped: true,
    };

    await stopSlackStream({ session });

    expect(stop).not.toHaveBeenCalled();
  });

  it("surfaces the error without re-throwing when streamer.stop fails", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("user_not_found"));
    const session = {
      streamer: { stop } as never,
      channel: "C001",
      threadTs: "123.456",
      stopped: false,
    };

    // Must not throw — the reply has already been delivered via append/start
    await expect(stopSlackStream({ session })).resolves.toBeUndefined();

    // The session should still be marked as stopped so no double-stop fires
    expect(session.stopped).toBe(true);

    // Calling again should be a no-op (idempotent after error)
    await stopSlackStream({ session });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("marks session stopped even when streamer.stop throws", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("missing_recipient_user_id"));
    const session = {
      streamer: { stop } as never,
      channel: "C001",
      threadTs: "123.456",
      stopped: false,
    };

    await stopSlackStream({ session });

    expect(session.stopped).toBe(true);
    // Calling again should be a no-op
    await stopSlackStream({ session });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
