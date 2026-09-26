import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { createRealtimeEndCallDrain } from "./realtime-end-call.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("realtime end-call playback drain", () => {
  it("allows overdue audio sent after a stalled pacer tick to play before timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let clockMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const sent: string[] = [];
    const pendingMarkAcks = new Map<string, () => void>();
    const pacer = new RealtimeAudioPacer({
      serializer: {
        media: () => "media",
        mark: (name) => `mark:${name}`,
        clear: () => "clear",
      },
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    const drain = createRealtimeEndCallDrain({
      getEstimatedCarrierBufferedMs: () => pacer.getEstimatedCarrierBufferedMs(),
      pendingMarkAcks,
      sendMark: (name, onSent) => pacer.sendMark(name, onSent),
    });

    pacer.sendAudio(Buffer.alloc(160 * 150, 0x7f)); // Three seconds of speech.
    const completed = vi.fn();
    const completion = drain.drainPlaybackBeforeEndCall();
    void completion.then(completed);

    clockMs = 3_000;
    vi.setSystemTime(3_000); // The event loop was blocked while the pump timer waited.
    expect(sent.some((message) => message.startsWith("mark:"))).toBe(false);
    expect(completed).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();
    const terminalMark = sent.find((message) => message.startsWith("mark:"))?.slice(5);
    expect(terminalMark).toEqual(expect.any(String));
    expect(pacer.getEstimatedCarrierBufferedMs()).toBe(2_840);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(completed).not.toHaveBeenCalled();
    pendingMarkAcks.get(terminalMark ?? "")?.();
    await expect(completion).resolves.toBe("played");
  });
});
