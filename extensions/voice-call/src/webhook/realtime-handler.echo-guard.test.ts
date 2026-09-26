import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

// mu-law codes chosen so the decoded levels sit either side of the phantom guard floor
// (PHANTOM_GUARD_MIN_RMS = 0.035) and of each other by more than ECHO_OVERLAP_MARGIN (2.5x).
const ECHO_MULAW = 0x50; // rms ~= 0.0267 — assistant bleed returning through the line
const CALLER_MULAW = 0x30; // rms ~= 0.1190 — a caller talking over the assistant
const ASSISTANT_MULAW = 0x00; // peak output frame (never treated as input)

function mulawFrame(code: number, bytes = 160): Buffer {
  return Buffer.alloc(bytes, code);
}

async function sendMedia(ws: { send: (data: string) => void }, bytes: Buffer): Promise<void> {
  ws.send(JSON.stringify({ event: "media", media: { payload: bytes.toString("base64") } }));
}

async function waitForFrames(
  processEvent: ReturnType<typeof vi.fn>,
  expected: number,
): Promise<void> {
  await vi.waitFor(() => {
    const speechCalls = processEvent.mock.calls.filter(([event]) => event.type === "call.speech");
    expect(speechCalls.length).toBeGreaterThanOrEqual(expected);
  });
}

describe("RealtimeCallHandler echo/phantom input guard", () => {
  it("keeps a genuine caller turn that rises clearly above the learned echo floor", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-echo-overlap", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());

      // Assistant audio is still playing out; the quiet frames just below are its own bleed.
      callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      for (let index = 0; index < 6; index += 1) {
        await sendMedia(ws, mulawFrame(ECHO_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      // The caller now speaks over the assistant, well above the learned echo floor.
      for (let index = 0; index < 3; index += 1) {
        await sendMedia(ws, mulawFrame(CALLER_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      // Let the carrier frames reach the handler's input accounting before the provider finalises.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
      callbacks?.onTranscript?.("user", "Yes, book it for Friday.", true);

      await waitForFrames(processEvent as ReturnType<typeof vi.fn>, 1);
      const speech = (processEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        ([event]) => event.type === "call.speech",
      )?.[0] as { transcript?: string } | undefined;
      expect(speech?.transcript).toBe("Yes, book it for Friday.");
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });

  it("suppresses a phantom caller turn conjured only from assistant bleed", async () => {
    let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const { call, handler, processEvent } = createCarrierLifecycleHarness((request) => {
      callbacks = request;
      return createBridge(() => {});
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-echo-phantom", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());

      // Only assistant bleed reached the line: every input frame sits at the echo floor.
      callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      for (let index = 0; index < 6; index += 1) {
        await sendMedia(ws, mulawFrame(ECHO_MULAW));
        callbacks?.onAudio(mulawFrame(ASSISTANT_MULAW));
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
      callbacks?.onTranscript?.("user", "Please cancel the whole order.", true);

      // Give the handler a beat to decide, then assert nothing was persisted as caller speech.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const speechCalls = (processEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event.type === "call.speech",
      );
      expect(speechCalls).toHaveLength(0);
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });
});
