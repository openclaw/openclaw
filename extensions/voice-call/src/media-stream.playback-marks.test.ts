import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi } from "vitest";
import type { MediaStreamHandler } from "./media-stream.js";
import {
  createHandler,
  sendStart,
  startWsServer,
  waitForAbort,
} from "./media-stream.test-support.js";
import { connectWs, waitForClose, withTimeout } from "./websocket-test-support.js";

const requireRecord = createRequireRecord("record", "expected-label-record");
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

async function withPlaybackStream(
  streamSid: string,
  callSid: string,
  run: (handler: MediaStreamHandler, ws: WebSocket, events: TalkEvent[]) => Promise<void>,
) {
  const onConnect = vi.fn();
  const events: TalkEvent[] = [];
  const handler = createHandler({
    shouldAcceptStream: () => true,
    onConnect,
    onTalkEvent: (_callId, _streamSid, event) => events.push(event),
  });
  const server = await startWsServer(handler);
  let ws: WebSocket | undefined;
  try {
    ws = await connectWs(server.url);
    sendStart(ws, streamSid, callSid);
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    await run(handler, ws, events);
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      await waitForClose(ws);
    }
  } finally {
    ws?.terminate();
    await server.close();
  }
}

describe("MediaStreamHandler playback marks", () => {
  it("completes queued playback only after Twilio echoes its mark", async () => {
    await withPlaybackStream("MZ-mark", "CA-mark", async (handler, ws) => {
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
    });
  });

  it("ignores a playback mark echoed after clear", async () => {
    await withPlaybackStream("MZ-clear-mark", "CA-clear-mark", async (handler, ws, talkEvents) => {
      const outboundMark = nextWsMessage(ws);
      const playback = handler.queueTts("MZ-clear-mark", async (signal) => {
        await handler.sendMarkAndWait("MZ-clear-mark", "tts-cleared", 100, signal);
      });
      await withTimeout(outboundMark);
      handler.clearTtsQueue("MZ-clear-mark", "barge-in");
      await withTimeout(playback);
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);

      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-clear-mark",
          mark: { name: "tts-cleared" },
        }),
      );
      ws.close();
      await waitForClose(ws);
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);
    });
  });
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
