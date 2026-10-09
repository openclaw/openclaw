import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "./websocket-test-support.js";

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

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
};

const nextWsMessage = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(requireRecord(JSON.parse(rawDataToString(data)), "WebSocket message"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

describe("MediaStreamHandler playback marks", () => {
  it("completes queued playback only after Twilio echoes its mark", async () => {
    const onConnect = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-mark",
          start: { callSid: "CA-mark" },
        }),
      );
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

      const outboundMark = nextWsMessage(ws);
      let completed = false;
      const playback = handler
        .queueTts("MZ-mark", async (signal) => {
          await handler.sendMarkAndWait("MZ-mark", "tts-complete", 100, signal);
        })
        .then(() => {
          completed = true;
        });
      expect(await withTimeout(outboundMark)).toMatchObject({
        event: "mark",
        mark: { name: "tts-complete" },
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-mark",
          mark: { name: "tts-complete" },
        }),
      );
      await withTimeout(playback);
      expect(completed).toBe(true);

      ws.close();
      await waitForClose(ws);
    } finally {
      ws?.terminate();
      await server.close();
    }
  });

  it("ignores a playback mark echoed after clear", async () => {
    const onConnect = vi.fn();
    const talkEvents: TalkEvent[] = [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
      onTalkEvent: (_callId, _streamSid, event) => talkEvents.push(event),
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-clear-mark",
          start: { callSid: "CA-clear-mark" },
        }),
      );
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

      const outboundMark = nextWsMessage(ws);
      const playback = handler.queueTts("MZ-clear-mark", async (signal) => {
        await handler.sendMarkAndWait("MZ-clear-mark", "tts-cleared", 100, signal);
      });
      await withTimeout(outboundMark);
      handler.clearTtsQueue("MZ-clear-mark", "barge-in");
      await withTimeout(playback);
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);

      const state = handler as unknown as {
        ignoredPlaybackMarks: Map<string, Set<string>>;
      };
      expect(state.ignoredPlaybackMarks.get("MZ-clear-mark")).toContain("tts-cleared");
      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-clear-mark",
          mark: { name: "tts-cleared" },
        }),
      );
      await vi.waitFor(() => {
        expect(state.ignoredPlaybackMarks.get("MZ-clear-mark")?.has("tts-cleared") ?? false).toBe(
          false,
        );
      });
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);

      ws.close();
      await waitForClose(ws);
    } finally {
      ws?.terminate();
      await server.close();
    }
  });
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
});
