import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/client.js";
import { VoicePlugin } from "../internal/voice.js";
import { DiscordAudioTransport } from "./audio-transport.js";
import type {
  DiscordAudioCommand,
  DiscordAudioEvent,
  DiscordAudioWorkerOptions,
} from "./audio-worker-protocol.js";

const workerFactory = vi.hoisted(() => vi.fn());
vi.mock("./audio-worker-thread.js", () => ({ createDiscordAudioWorkerThread: workerFactory }));

class ControlledWorker extends EventEmitter {
  readonly sent: DiscordAudioCommand[] = [];
  postMessage(command: DiscordAudioCommand): void {
    this.sent.push(command);
  }
  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return 0;
  }
  message(event: DiscordAudioEvent): void {
    this.emit("message", event);
  }
}
const options: DiscordAudioWorkerOptions = {
  guildId: "guild",
  channelId: "voice",
  group: "test",
  selfDeaf: false,
  selfMute: false,
  connectTimeoutMs: 30_000,
  reconnectGraceMs: 15_000,
  captureSilenceGraceMs: 2_000,
  realtime: true,
};
const owned: Array<{ audio: DiscordAudioTransport; worker: ControlledWorker }> = [];
afterEach(async () => {
  for (const { audio, worker } of owned.splice(0)) {
    const stopped = audio.stop();
    worker.message({ type: "stopped" });
    worker.emit("exit", 0);
    await stopped;
  }
});
function fixture(sendPayload = vi.fn(() => true)) {
  const worker = new ControlledWorker();
  workerFactory.mockReturnValueOnce(worker);
  const destroy = vi.fn();
  const audio = new DiscordAudioTransport(options, () => ({ sendPayload, destroy }));
  owned.push({ audio, worker });
  return { audio, worker, destroy, sendPayload };
}

describe("Discord audio worker control boundary", () => {
  it("rejects startup and retires owned adapter state when the worker fails", async () => {
    const { audio, worker, destroy } = fixture();
    const stopped = vi.fn();
    audio.on("stopped", stopped);
    worker.emit("error", new Error("codec startup failed"));
    await expect(audio.ready).rejects.toThrow("codec startup failed");
    expect(stopped).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    worker.message({ type: "ready" });
    expect(audio.connectionStatus).toBe("destroyed");
  });

  it("stops the allocated worker if gateway adapter registration throws", () => {
    const worker = new ControlledWorker();
    const terminate = vi.spyOn(worker, "terminate");
    workerFactory.mockReturnValueOnce(worker);
    expect(
      () =>
        new DiscordAudioTransport(options, () => {
          throw new Error("gateway unavailable");
        }),
    ).toThrow("gateway unavailable");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("reports definite main-gateway send failure back to the media owner", async () => {
    const { audio, worker } = fixture(vi.fn(() => false));
    worker.message({ type: "ready" });
    await audio.ready;
    worker.message({
      type: "gateway-send",
      payload: {
        op: 4,
        d: { guild_id: "guild", channel_id: "voice", self_mute: false, self_deaf: false },
      },
    });
    expect(worker.sent.at(-1)).toEqual({ type: "gateway-failed" });
  });

  it("settles captures on worker loss and ignores late frames after terminal teardown", async () => {
    const { audio, worker } = fixture();
    worker.message({ type: "ready" });
    await audio.ready;
    const capture = audio.subscribe("speaker", new SharedArrayBuffer(8));
    const errors = vi.fn();
    capture.on("error", errors);
    const stopped = audio.stop();
    worker.emit("exit", 1);
    await stopped;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(capture.destroyed).toBe(true);
    expect(errors).toHaveBeenCalledOnce();
    worker.message({
      type: "capture-frame",
      id: capture.id,
      frame: {
        pcm: new Uint8Array(4),
        packet: new Uint8Array(1),
        receivedAt: 1,
        recordingEpoch: 0n,
      },
    });
    expect(capture.readableLength).toBe(0);
    expect(worker.sent.filter((command) => command.type === "stop")).toHaveLength(1);
  });

  it("releases physical shutdown before draining admitted recording frames without an error", async () => {
    const { audio, worker, destroy } = fixture();
    worker.message({ type: "ready" });
    await audio.ready;
    const capture = audio.subscribe("speaker", new SharedArrayBuffer(8));
    const errors = vi.fn();
    capture.on("error", errors);
    const received: number[] = [];
    const recording = (async () => {
      for await (const frame of capture) {
        received.push(frame.pcm[0]);
      }
    })();
    const stopped = audio.stop();
    worker.message({ type: "gateway-destroy" });
    await stopped;
    expect(destroy).toHaveBeenCalledOnce();
    expect(capture.destroyed).toBe(false);
    worker.message({ type: "capture-finalized", id: capture.id });
    worker.message({
      type: "capture-frame",
      id: capture.id,
      frame: {
        pcm: new Uint8Array([7, 0]),
        packet: new Uint8Array([1]),
        receivedAt: 1,
        recordingEpoch: 1n,
      },
    });
    worker.message({ type: "capture-end", id: capture.id });
    worker.message({ type: "stopped" });
    worker.emit("exit", 0);
    await recording;
    expect(received).toEqual([7]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("delivers physical finalization after decoded EOF already closed the readable", async () => {
    const { audio, worker } = fixture();
    worker.message({ type: "ready" });
    await audio.ready;
    const capture = audio.subscribe("speaker", new SharedArrayBuffer(8));
    const finalized = vi.fn();
    capture.once("finalized", finalized);
    capture.resume();
    const closed = new Promise<void>((resolve) => {
      capture.once("close", resolve);
    });
    worker.message({ type: "capture-end", id: capture.id });
    await closed;
    expect(capture.destroyed).toBe(true);
    expect(finalized).not.toHaveBeenCalled();
    worker.message({ type: "capture-finalized", id: capture.id });
    expect(finalized).toHaveBeenCalledOnce();
  });

  it("does not let a retired adapter unregister a newer guild generation", () => {
    const voice = new VoicePlugin();
    voice.registerClient({ getPlugin: () => ({ send: vi.fn() }) } as unknown as Client);
    const methods = () => ({
      onVoiceServerUpdate: vi.fn(),
      onVoiceStateUpdate: vi.fn(),
      destroy: vi.fn(),
    });
    const old = methods();
    const current = methods();
    const first = voice.getGatewayAdapterCreator("guild")(old);
    const second = voice.getGatewayAdapterCreator("guild")(current);
    first.destroy();
    expect(voice.adapters.get("guild")).toBe(current);
    second.destroy();
    expect(voice.adapters.has("guild")).toBe(false);
  });
});
