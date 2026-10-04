import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

// mu-law codes around the local speech gate (rms 0.035).
const QUIET_ECHO_MULAW = 0x58; // rms ~= 0.0189 — quiet onset of a playback segment
const LOUD_ECHO_MULAW = 0x48; // rms ~= 0.0419 — echo above the speech gate
const VOICED_ECHO_MULAW = 0x40; // rms ~= 0.0575 — a voiced echo syllable after a quiet onset
const LOUD_CALLER_MULAW = 0x20; // rms ~= 0.2421 — a caller talking loudly
const ASSISTANT_MULAW = 0x00; // assistant output frame (never treated as input)

function mulawFrame(code: number, bytes = 160): Buffer {
  return Buffer.alloc(bytes, code);
}

describe("RealtimeCallHandler local barge-in during assistant playout", () => {
  async function startEchoCall(streamSid: string) {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const handleBargeIn = vi.fn();
    const sendAudio = vi.fn();
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {}, { handleBargeIn, sendAudio });
    });
    // connectCarrierStream owns socket, handler, and server teardown.
    const { ws } = await connectCarrierStream(handler);
    ws.send(JSON.stringify({ event: "start", start: { streamSid, callSid: call.providerCallId } }));
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const sendMedia = (code: number) => {
      ws.send(
        JSON.stringify({ event: "media", media: { payload: mulawFrame(code).toString("base64") } }),
      );
    };
    // Each inbound frame arrives alongside a new assistant frame handed to the pacer.
    const sendFramesUnderAssistant = async (code: number, count: number) => {
      const expected = sendAudio.mock.calls.length + count;
      for (let index = 0; index < count; index += 1) {
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
        sendMedia(code);
      }
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledTimes(expected));
    };
    // Carrier frames with no new assistant audio submitted alongside them.
    const sendInboundFrames = async (code: number, count: number) => {
      const expected = sendAudio.mock.calls.length + count;
      for (let index = 0; index < count; index += 1) {
        sendMedia(code);
      }
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledTimes(expected));
    };
    const speechTranscripts = () =>
      (processEvent as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]) => event.type === "call.speech")
        .map(([event]) => (event as { transcript?: string }).transcript);
    return {
      bridgeSendAudio: sendAudio,
      callbacks: () => callbacks,
      handleBargeIn,
      sendFramesUnderAssistant,
      sendInboundFrames,
      speechTranscripts,
    };
  }

  it("does not barge in on echo while a chunk longer than the tail is still playing out", async () => {
    const harness = await startEchoCall("MZ-echo-long-chunk");
    // Drive the pacer's telephony clock and the wall clock together.
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      // One provider chunk holding 4 s of audio, far longer than the playback tail.
      harness.callbacks()?.onAudio(mulawFrame(ASSISTANT_MULAW, 8 * 4_000));
      // The pacer has handed every frame to the carrier; the last 100 ms are still playing.
      vi.advanceTimersByTime(3_900);
      // The caller stays silent: the inbound frames are loud echo of that playout.
      await harness.sendInboundFrames(LOUD_ECHO_MULAW, 12);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not barge in on a voiced echo syllable after a quiet playback onset", async () => {
    // Real line echo starts quiet and then rises on voiced syllables; the level jump is not caller
    // evidence while our own audio is on the line.
    const harness = await startEchoCall("MZ-echo-onset");
    try {
      await harness.sendFramesUnderAssistant(QUIET_ECHO_MULAW, 6);
      await harness.sendFramesUnderAssistant(VOICED_ECHO_MULAW, 6);
      await harness.sendFramesUnderAssistant(LOUD_ECHO_MULAW, 6);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();
    } finally {
    }
  });

  it("forwards caller overlap to the provider and commits its transcript", async () => {
    const harness = await startEchoCall("MZ-echo-overlap");
    try {
      await harness.sendFramesUnderAssistant(QUIET_ECHO_MULAW, 4);
      await harness.sendFramesUnderAssistant(LOUD_CALLER_MULAW, 4);
      // The provider owns barge-in during playout: every inbound frame still reaches it.
      expect(harness.bridgeSendAudio).toHaveBeenCalledTimes(8);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();

      // The host never drops a provider-committed caller turn, even while playout is active.
      harness.callbacks()?.onTranscript?.("user", "Stop, wrong address.", true);
      await vi.waitFor(() => expect(harness.speechTranscripts()).toEqual(["Stop, wrong address."]));
    } finally {
    }
  });

  it("barges in on caller speech once the playout window has closed", async () => {
    const harness = await startEchoCall("MZ-echo-after-window");
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      harness.callbacks()?.onAudio(mulawFrame(ASSISTANT_MULAW, 8 * 1_000));
      await harness.sendInboundFrames(LOUD_ECHO_MULAW, 4);
      expect(harness.handleBargeIn).not.toHaveBeenCalled();

      // Playout (1 s) and the tail have finished; the line is quiet again.
      vi.advanceTimersByTime(2_000);
      await harness.sendInboundFrames(LOUD_CALLER_MULAW, 4);
      expect(harness.handleBargeIn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
