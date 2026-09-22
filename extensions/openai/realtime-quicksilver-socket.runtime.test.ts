import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverSocketRuntime } from "./realtime-quicksilver-socket.runtime.js";
import {
  QuicksilverSocketAudioQueue,
  type QuicksilverSocketMessage,
} from "./realtime-quicksilver-socket.shared.js";

class WireSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
  frame(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
}

function owner(paced = true, bufferedAmount = () => 0) {
  const socket = new WireSocket();
  const messages: QuicksilverSocketMessage[] = [];
  const dispose = vi.fn();
  const runtime = new OpenAIQuicksilverSocketRuntime(
    socket,
    { model: "gpt-live-1", paced },
    (event) => messages.push(event),
    dispose,
    bufferedAmount,
  );
  return { socket, runtime, messages, dispose };
}

describe("GPT-Live socket media owner", () => {
  it("keeps a copied newest raw-byte tail without truncating odd telephony chunks", () => {
    const pending = new QuicksilverSocketAudioQueue(5);
    const capture = Buffer.from([1, 2, 3]);
    pending.append(capture);
    capture.fill(0);
    pending.append(Buffer.from([4, 5, 6]));
    expect(pending.length).toBe(5);
    expect(pending.take(3)).toEqual(Buffer.from([2, 3, 4]));
    pending.append(Buffer.from([7, 8, 9, 10]));
    expect(pending.take()).toEqual(Buffer.from([6, 7, 8, 9, 10]));
    pending.clear();
    expect(pending.length).toBe(0);
  });

  it("bounds worker-to-parent audio behind one credit and never forwards base64 frames", () => {
    const { socket, runtime, messages } = owner();
    for (let index = 0; index < 1_000; index++) {
      socket.frame({
        type: "session.output_audio.delta",
        delta: Buffer.alloc(960, index % 256).toString("base64"),
      });
    }
    expect(messages).toHaveLength(1);
    const emitted: Buffer[] = [];
    for (let index = 0; index < 260; index++) {
      const message = messages.shift();
      if (!message) {
        break;
      }
      expect(message.type).toBe("audio");
      if (message.type === "audio") {
        emitted.push(Buffer.from(message.audio));
      }
      runtime.command({ type: "event-ack" });
    }
    expect(Buffer.concat(emitted).length).toBeLessThanOrEqual(240_000 + 960);
    expect(emitted.at(-1)).toEqual(Buffer.alloc(960, 999 % 256));
    expect(messages).toEqual([]);
    socket.close();
  });

  it("stops media before session.close but retains ordered final transcripts and receipt", () => {
    const { socket, runtime, messages, dispose } = owner();
    runtime.command({ type: "audio", audio: Buffer.alloc(960, 1) });
    runtime.command({ type: "start-audio" });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "session.input_audio.append",
      audio: Buffer.alloc(960, 1).toString("base64"),
    });
    runtime.command({ type: "stop-audio" });
    runtime.command({ type: "audio", audio: Buffer.alloc(960, 2) });
    socket.frame({ type: "session.output_audio.delta", delta: "AAE=" });
    runtime.command({ type: "send", payload: JSON.stringify({ type: "session.close" }) });
    socket.frame({
      type: "session.input_transcript.delta",
      delta: "last words",
      start_ms: 0,
      end_ms: 100,
    });
    socket.frame({ type: "session.closed", reason: "close_requested" });
    runtime.command({ type: "event-ack" });
    expect(messages.filter((message) => message.type === "audio")).toEqual([]);
    expect(
      messages
        .filter((message) => message.type === "frame")
        .map((message) => JSON.parse(Buffer.from(message.data).toString()).type),
    ).toEqual(["session.input_transcript.delta", "session.closed"]);
    runtime.command({ type: "close", code: 1000, reason: "session closed" });
    runtime.command({ type: "event-ack" });
    runtime.command({ type: "event-ack" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(2);
  });

  it("sends native PCM and interruption directly to the sink, then fences it before transcript drain", async () => {
    const { port1, port2 } = new MessageChannel();
    const state = new SharedArrayBuffer(4);
    const socket = new WireSocket();
    const messages: QuicksilverSocketMessage[] = [];
    const runtime = new OpenAIQuicksilverSocketRuntime(
      socket,
      {
        model: "gpt-live-test",
        paced: true,
        audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
      },
      (message) => messages.push(message),
      () => {},
      () => 0,
    );
    try {
      runtime.command({ type: "audio-output", output: { port: port1, state } });
      const pcm = Buffer.alloc(960, 1);
      const audio = once(port2, "message");
      socket.frame({ type: "output_audio.delta", audio: pcm.toString("base64") });
      expect((await audio)[0]).toEqual({ type: "audio", audio: new Uint8Array(pcm) });
      expect(messages).toEqual([]);
      const cleared = once(port2, "message");
      socket.frame({ type: "output_audio_buffer.cleared" });
      expect((await cleared)[0]).toEqual({ type: "clear" });
      runtime.command({ type: "event-ack" });
      runtime.command({ type: "stop-audio" });
      expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
      socket.frame({ type: "turn.done", turn: { role: "assistant", transcript: "final words" } });
      expect(
        messages
          .filter((message) => message.type === "frame")
          .map((message) => JSON.parse(Buffer.from(message.data).toString()).type),
      ).toEqual(["output_audio_buffer.cleared", "turn.done"]);
      expect(messages.some((message) => message.type === "audio")).toBe(false);
    } finally {
      socket.close();
      port1.close();
      port2.close();
    }
  });

  it.each(["control", "socket-write", "malformed-audio"] as const)(
    "fails closed on %s overflow without exposing transport data",
    (cause) => {
      const { socket, runtime, messages } = owner(true, () =>
        cause === "socket-write" ? 1024 * 1024 : 0,
      );
      if (cause === "control") {
        for (let index = 0; index < 140; index++) {
          socket.frame({ type: "private-fixture", value: index });
        }
      } else if (cause === "socket-write") {
        runtime.command({ type: "start-audio" });
      } else {
        socket.frame({ type: "session.output_audio.delta", delta: "private-invalid-audio!" });
      }
      for (let index = 0; index < 140; index++) {
        runtime.command({ type: "event-ack" });
      }
      expect(socket.readyState).toBe(3);
      expect(messages.filter((message) => message.type === "error")).toEqual([{ type: "error" }]);
      expect(messages.filter((message) => message.type === "close")).toHaveLength(1);
    },
  );
});
