import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  postMessage = vi.fn<(command: DiscordAudioCommand) => void>();
  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return 0;
  }
}
const options: DiscordAudioWorkerOptions = {
  guildId: "guild",
  channelId: "voice",
  connectTimeoutMs: 30_000,
  reconnectGraceMs: 15_000,
  captureSilenceGraceMs: 2_000,
  realtime: true,
};
const owned: Array<{ audio: DiscordAudioTransport; worker: ControlledWorker }> = [];
afterEach(async () => {
  for (const { audio, worker } of owned.splice(0)) {
    const stopped = audio.stop();
    worker.emit("message", { type: "stopped" });
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
  return { audio, worker, destroy };
}
async function readyFixture(sendPayload?: Parameters<typeof fixture>[0]) {
  const result = fixture(sendPayload);
  result.worker.emit("message", { type: "ready" });
  await result.audio.ready;
  return result;
}
function frame(id: number, value = 0): DiscordAudioEvent {
  return {
    type: "capture-frame",
    id,
    frame: {
      pcm: Uint8Array.of(value, 0),
      packet: Uint8Array.of(1),
      receivedAt: 1,
      recordingEpoch: 1n,
    },
  };
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
    worker.emit("message", { type: "ready" });
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
    const { worker } = await readyFixture(vi.fn(() => false));
    worker.emit("message", {
      type: "gateway-send",
      payload: {
        op: 4,
        d: { guild_id: "guild", channel_id: "voice", self_mute: false, self_deaf: false },
      },
    });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "gateway-failed" }, undefined);
  });

  it("waits for physical termination when the worker exceeds its stop grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { audio, worker, destroy } = await readyFixture();
    const exited = createDeferred<number>();
    const terminate = vi.spyOn(worker, "terminate").mockReturnValue(exited.promise);
    let settled = false;
    const stopping = audio.stop().then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(terminate).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      worker.emit("exit", 0);
      exited.resolve(0);
      await stopping;
      vi.useRealTimers();
    }
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("settles captures on worker loss and ignores late frames after terminal teardown", async () => {
    const { audio, worker } = await readyFixture();
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
    worker.emit("message", frame(capture.id));
    expect(capture.readableLength).toBe(0);
    expect(
      worker.postMessage.mock.calls.filter(([command]) => command.type === "stop"),
    ).toHaveLength(1);
  });

  it("releases physical shutdown before draining admitted recording frames without an error", async () => {
    const { audio, worker, destroy } = await readyFixture();
    const capture = audio.subscribe("speaker", new SharedArrayBuffer(8));
    const errors = vi.fn();
    capture.on("error", errors);
    const received: number[] = [];
    const recording = (async () => {
      for await (const captured of capture) {
        received.push(captured.pcm[0]);
      }
    })();
    const stopped = audio.stop();
    worker.emit("message", { type: "gateway-destroy" });
    await stopped;
    expect(destroy).toHaveBeenCalledOnce();
    expect(capture.destroyed).toBe(false);
    worker.emit("message", { type: "capture-finalized", id: capture.id });
    worker.emit("message", frame(capture.id, 7));
    worker.emit("message", { type: "capture-end", id: capture.id });
    worker.emit("message", { type: "stopped" });
    worker.emit("exit", 0);
    await recording;
    expect(received).toEqual([7]);
    expect(errors).not.toHaveBeenCalled();
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
