import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type Callbacks = {
  onopen(): void;
  onmessage(message: Record<string, unknown>): void;
  onclose(event: { code: number; reason: string }): void;
};

function mockSession() {
  return {
    close: vi.fn(),
    sendRealtimeInput:
      vi.fn<(input: { audio?: { data: string }; audioStreamEnd?: boolean }) => void>(),
  };
}

const { connect } = vi.hoisted(() => ({
  connect: vi.fn<(request: { callbacks: Callbacks }) => Promise<ReturnType<typeof mockSession>>>(),
}));
vi.mock("./google-genai-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-genai-runtime.js")>()),
  createGoogleGenAI: () => ({ live: { connect } }),
}));

function acceptConnection() {
  const session = mockSession();
  connect.mockImplementationOnce(async ({ callbacks }) => {
    callbacks.onopen();
    callbacks.onmessage({ setupComplete: {} });
    return session;
  });
  return session;
}

function createBridge(silenceDurationMs?: number) {
  return buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "test-key", silenceDurationMs },
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
}

function sentInputPcm(session: ReturnType<typeof mockSession>): Buffer {
  return Buffer.concat(
    session.sendRealtimeInput.mock.calls.flatMap(([input]) =>
      input.audio ? [Buffer.from(input.audio.data, "base64")] : [],
    ),
  );
}

afterEach(() => {
  connect.mockReset();
  vi.useRealTimers();
});

describe("Google Live input audio", () => {
  it("preserves queued and live PCM through stream end and flushes the next input on close", async () => {
    const session = acceptConnection();
    const bridge = createBridge(1);
    const input = Buffer.alloc(384 * 2);
    for (let i = 0; i < 384; i++) {
      input.writeInt16LE(1 + ((i * 2389) % 29_000), i * 2);
    }
    bridge.sendAudio(input.subarray(0, 256));
    await bridge.connect();
    bridge.sendAudio(input.subarray(256, 512));
    bridge.sendAudio(input.subarray(512));
    const silence = Buffer.alloc(24 * 2);
    bridge.sendAudio(silence);
    expect(session.sendRealtimeInput.mock.lastCall).toEqual([{ audioStreamEnd: true }]);
    expect(sentInputPcm(session)).toEqual(
      resamplePcm(Buffer.concat([input, silence]), 24_000, 16_000),
    );

    session.sendRealtimeInput.mockClear();
    const sample = Buffer.from([1, 0]);
    bridge.sendAudio(sample);
    bridge.sendAudio(sample);
    await bridge.close();
    expect(sentInputPcm(session)).toEqual(
      resamplePcm(Buffer.concat([sample, sample]), 24_000, 16_000),
    );
  });

  it.each([true, false])(
    "keeps pending input PCM only on a resumed session (resumable: %s)",
    async (resumable) => {
      vi.useFakeTimers();
      acceptConnection();
      const nextSession = acceptConnection();
      const bridge = createBridge();
      await bridge.connect();
      const callbacks = connect.mock.lastCall?.[0].callbacks;
      assert.isDefined(callbacks);
      const first = Buffer.from([1, 0]);
      const next = Buffer.from([2, 0, 3, 0]);
      bridge.sendAudio(first);
      if (resumable) {
        callbacks.onmessage({
          sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
        });
      }
      callbacks.onclose({ code: 1011, reason: "temporary" });
      bridge.sendAudio(next);
      await vi.advanceTimersByTimeAsync(250);
      await bridge.close();
      expect(sentInputPcm(nextSession)).toEqual(
        resamplePcm(resumable ? Buffer.concat([first, next]) : next, 24_000, 16_000),
      );
    },
  );

  it("bounds pending audio by chunk count before activation", async () => {
    const session = acceptConnection();
    const bridge = createBridge();

    const chunks = Array.from({ length: 321 }, (_, i) => Buffer.alloc(2, i & 0xff));
    for (const chunk of chunks) {
      bridge.sendAudio(chunk);
    }

    await bridge.connect();

    await bridge.close();
    expect(sentInputPcm(session)).toEqual(
      resamplePcm(Buffer.concat(chunks.slice(0, 320)), 24_000, 16_000),
    );
  });
});
