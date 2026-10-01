import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import { withTimeout } from "./websocket-test-support.js";

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin => ({
  createSession: () => ({
    connect: async () => {},
    sendAudio: () => {},
    close: () => {},
    isConnected: () => true,
  }),
  id: "openai",
  label: "OpenAI",
  isConfigured: () => true,
});

const createHandler = (): MediaStreamHandler =>
  new MediaStreamHandler({
    transcriptionProvider: createStubSttProvider(),
    providerConfig: {},
  });

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

describe("MediaStreamHandler TTS queue", () => {
  it("bounds pending playback per stream and recovers after draining", async () => {
    const handler = createHandler();
    const activeGate = createDeferred<void>();
    const playbackOrder: number[] = [];

    const active = handler.queueTts("stream-1", async () => {
      playbackOrder.push(0);
      await activeGate.promise;
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
      handler.queueTts("stream-1", async () => {
        playbackOrder.push(index + 1);
      }),
    );
    let overflowRan = false;

    await expect(
      handler.queueTts("stream-1", async () => {
        overflowRan = true;
      }),
    ).rejects.toThrow("Telephony TTS queue is full for stream; maxPending=8");

    await handler.queueTts("stream-2", async () => {});
    expect(overflowRan).toBe(false);
    expect(playbackOrder).toEqual([0]);

    activeGate.resolve();
    await active;
    await Promise.all(pending);
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    await handler.queueTts("stream-1", async () => {
      playbackOrder.push(9);
    });
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = createHandler();
    let queuedRan = false;
    const started: string[] = [];

    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    expect(started).toEqual(["active"]);

    handler.clearTtsQueue("stream-1");
    await active;
    await withTimeout(queued);

    expect(queuedRan).toBe(false);
  });

  it("removes all queue state during stream teardown", async () => {
    const handler = createHandler();
    let queuedRan = false;
    const active = handler.queueTts("stream-1", async (signal) => {
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    (
      handler as unknown as {
        clearTtsState(streamSid: string): void;
      }
    ).clearTtsState("stream-1");

    await withTimeout(active);
    await withTimeout(queued);
    expect(queuedRan).toBe(false);

    const state = handler as unknown as {
      ttsQueues: Map<string, unknown[]>;
      ttsPlaying: Map<string, boolean>;
      ttsActiveControllers: Map<string, AbortController>;
    };
    expect(state.ttsQueues.has("stream-1")).toBe(false);
    expect(state.ttsPlaying.has("stream-1")).toBe(false);
    expect(state.ttsActiveControllers.has("stream-1")).toBe(false);
  });
});
