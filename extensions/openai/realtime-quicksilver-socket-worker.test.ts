import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { OpenAIQuicksilverAudioClock } from "./realtime-quicksilver-audio-buffer.js";
import { closeOpenAILiveSocket } from "./realtime-quicksilver-protocol.js";
import { OpenAIQuicksilverWorkerSocket } from "./realtime-quicksilver-socket.js";

// Timestamp the actual network receiver, not callbacks queued on the blocked
// Gateway. This intentionally runs both the old clock/socket baseline and the
// production worker path against the same independent server event loop.
const receiverSource =
  "const { parentPort, workerData } = require('node:worker_threads');\nconst { fileURLToPath } = require('node:url');\nconst { WebSocketServer } = require(fileURLToPath(workerData.wsUrl));\nconst counts = new Int32Array(workerData.count);\nconst times = new Float64Array(workerData.times);\nconst outputCounts = new Int32Array(workerData.outputCount);\nconst outputState = new Int32Array(workerData.outputState);\nworkerData.outputPort.on('message', message => {\n  if (message.type === 'audio') {\n    if (Atomics.load(outputState, 0) === 0 && message.audio instanceof Uint8Array && message.audio.byteLength === 960 && message.audio[0] === 1 && message.audio[1] === 1) Atomics.add(outputCounts, 0, 1);\n    workerData.outputPort.postMessage({ type: 'ack' });\n  }\n});\nconst server = new WebSocketServer({ host: '127.0.0.1', port: 0 });\nserver.on('connection', socket => socket.on('message', data => {\n  const event = JSON.parse(data.toString());\n  if (event.type === 'session.input_audio.append') {\n    const index = Atomics.load(counts, 0);\n    times[index] = performance.now();\n    Atomics.store(counts, 0, index + 1);\n    socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: event.audio }));\n  }\n  if (event.type === 'session.close') {\n    socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'final transcript', start_ms: 0, end_ms: 100 }));\n    socket.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested' }));\n  }\n}));\nserver.on('listening', () => parentPort.postMessage('ws://127.0.0.1:' + server.address().port));";

describe("GPT-Live socket worker", () => {
  it("keeps actual PCM packets paced during a blocked Gateway and drains final transcripts", async () => {
    const count = new Int32Array(new SharedArrayBuffer(4));
    const times = new Float64Array(new SharedArrayBuffer(4096 * 8));
    const outputCount = new Int32Array(new SharedArrayBuffer(4));
    const outputState = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const callbackAudio: Buffer[] = [];
    const receiver = new Worker(receiverSource, {
      eval: true,
      workerData: {
        count: count.buffer,
        times: times.buffer,
        wsUrl: pathToFileURL(createRequire(import.meta.url).resolve("ws")).href,
        outputPort: port2,
        outputCount: outputCount.buffer,
        outputState,
      },
      transferList: [port2],
    });
    const errors: Error[] = [];
    let direct: OpenAIQuicksilverWorkerSocket | undefined;
    let baseline: WebSocket | undefined;
    let clock: OpenAIQuicksilverAudioClock | undefined;
    try {
      const [url] = await once(receiver, "message");
      baseline = new WebSocket(String(url));
      await once(baseline, "open");
      const baselineSocket = baseline;
      clock = new OpenAIQuicksilverAudioClock(() =>
        baselineSocket.send(
          JSON.stringify({
            type: "session.input_audio.append",
            audio: Buffer.alloc(960).toString("base64"),
          }),
        ),
      );
      clock.start();
      await waitForPackets(count, 5);
      const beforeBaseline = Atomics.load(count, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const baselineDuringStall = Atomics.load(count, 0) - beforeBaseline;
      clock.stop();
      baseline.close();
      await once(baseline, "close");

      direct = OpenAIQuicksilverWorkerSocket.create(
        String(url),
        { headers: { Authorization: "Bearer synthetic-fixture" }, maxPayload: 16 * 1024 * 1024 },
        { model: "gpt-live-1", paced: true },
        { onAudio: (audio) => callbackAudio.push(audio) },
      );
      direct.on("error", (error) => errors.push(error));
      await once(direct, "open");
      direct.setAudioOutputPort({ port: port1, state: outputState });
      const frames: string[] = [];
      direct.on("message", (data) => frames.push(data.toString()));
      direct.sendAudio(Buffer.alloc(240_000, 1));
      direct.startAudio();
      await waitForPackets(count, beforeBaseline + baselineDuringStall + 5);
      await waitForPackets(outputCount, 5);
      const beforeOutput = Atomics.load(outputCount, 0);
      const beforeWorker = Atomics.load(count, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const afterWorker = Atomics.load(count, 0);
      const workerDuringStall = afterWorker - beforeWorker;
      const outputDuringStall = Atomics.load(outputCount, 0) - beforeOutput;
      const gaps = Array.from(
        { length: Math.max(0, workerDuringStall - 1) },
        (_, index) => times[beforeWorker + index + 1]! - times[beforeWorker + index]!,
      );
      console.info(
        JSON.stringify({
          baselineDuring500msStall: baselineDuringStall,
          workerDuring500msStall: workerDuringStall,
          outputDuring500msStall: outputDuringStall,
          workerPacketGapsMs: gaps,
        }),
      );
      expect(baselineDuringStall).toBeLessThanOrEqual(1);
      expect(workerDuringStall).toBeGreaterThanOrEqual(10);
      expect(outputDuringStall).toBeGreaterThanOrEqual(10);
      expect(callbackAudio).toEqual([]);
      expect(Math.max(...gaps)).toBeLessThan(180);
      direct.stopAudio();
      expect(Atomics.load(new Int32Array(outputState), 0)).toBe(1);
      await expect(closeOpenAILiveSocket(direct)).resolves.toBe("close_requested");
      expect(frames.map((frame) => JSON.parse(frame).type)).toEqual([
        "session.input_transcript.delta",
        "session.closed",
      ]);
      expect(errors).toEqual([]);
    } finally {
      clock?.stop();
      baseline?.terminate();
      direct?.close();
      port1.close();
      port2.close();
      await receiver.terminate();
    }
  }, 30_000);

  it("retires a worker closed before WebSocket startup without late open or audio", async () => {
    const opened: string[] = [];
    const audio: Buffer[] = [];
    const socket = OpenAIQuicksilverWorkerSocket.create(
      "ws://127.0.0.1:1",
      { maxPayload: 1024 },
      { model: "gpt-live-1", paced: true },
      { onAudio: (chunk) => audio.push(chunk) },
    );
    socket.once("open", () => opened.push("open"));
    socket.on("error", () => {});
    const closed = once(socket, "close");
    socket.sendAudio(Buffer.alloc(960));
    socket.close();
    socket.close();
    await closed;
    socket.startAudio();
    socket.sendAudio(Buffer.alloc(960));
    expect(opened).toEqual([]);
    expect(audio).toEqual([]);
    expect(socket.readyState).toBe(3);
  }, 10_000);
});

async function waitForPackets(count: Int32Array, minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Atomics.load(count, 0) < minimum && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  expect(Atomics.load(count, 0)).toBeGreaterThanOrEqual(minimum);
}
