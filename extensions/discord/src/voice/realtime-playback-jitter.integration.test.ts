import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { AudioResource } from "@discordjs/voice";
import { loadLibopus } from "libopus-wasm";
import { expect, it, vi } from "vitest";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

function tone(frame: number): Buffer {
  const pcm = Buffer.alloc(960);
  for (let sample = 0; sample < 480; sample += 1) {
    pcm.writeInt16LE(
      Math.round(4_000 * Math.sin(((frame * 480 + sample) * Math.PI * 880) / 24_000)),
      sample * 2,
    );
  }
  return pcm;
}

it("absorbs an 80 ms delivery reorder gap without inserting playback silence", async () => {
  await loadLibopus();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const resources = new Set<AudioResource>();
  let complete = false;
  let missingFrames = 0;
  let consumedMs: number | undefined;
  fixture.player.on("stateChange", (_previous, state) => {
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle || resources.has(state.resource)) {
      return;
    }
    resources.add(state.resource);
    const read = state.resource.read.bind(state.resource);
    vi.spyOn(state.resource, "read").mockImplementation(() => {
      const packet = read();
      if (!packet && !complete) {
        missingFrames += 1;
      }
      return packet;
    });
  });
  try {
    let previousArrival = 0;
    for (let frame = 0; frame < 100; frame += 1) {
      const arrival = Math.max(previousArrival, frame * 20 + (frame % 20 === 5 ? 80 : 0));
      previousArrival = arrival;
      setTimeout(() => {
        fixture.callbacks.onAudio(tone(frame), { itemId: "reply" });
        if (frame === 99) {
          fixture.callbacks.onMark?.("complete", () => {
            consumedMs = fixture.callbacks.getPlaybackState?.()[0]?.audioEndMs;
            complete = true;
          });
        }
      }, arrival);
    }
    for (let elapsed = 0; elapsed < 3_000; elapsed += 1) {
      await vi.advanceTimersByTimeAsync(1);
      // The real encoder yields with setImmediate; let it run between packet-clock ticks.
      await nextEventLoopTurn();
      if (complete) {
        break;
      }
    }
    expect(complete).toBe(true);
    expect(consumedMs).toBe(2_000);
    expect(missingFrames).toBe(0);
    expect(resources.size).toBe(1);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("retires a short continuous reply before its startup deadline without late playback", async () => {
  await loadLibopus();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const play = vi.spyOn(fixture.player, "play");
  try {
    fixture.callbacks.onAudio(tone(0));
    expect(play).not.toHaveBeenCalled();
    fixture.callbacks.onClearAudio();
    await vi.advanceTimersByTimeAsync(200);
    await nextEventLoopTurn();
    expect(play).not.toHaveBeenCalled();
    expect(fixture.playback.isOutputAudioActive()).toBe(false);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it.each(["finish", "cancel"] as const)(
  "preserves room order when a later speaker fills preroll first (%s)",
  async (firstAction) => {
    await loadLibopus();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
    const next = fixture.createLane();
    const heard: string[] = [];
    try {
      fixture.callbacks.onAudio(tone(0));
      fixture.callbacks.onMark?.("first", () => heard.push("first"));
      next.callbacks.onAudio(Buffer.concat(Array.from({ length: 6 }, (_, frame) => tone(frame))));
      next.callbacks.onMark?.("second", () => heard.push("second"));
      next.callbacks.onResponseDone?.({ status: "completed" });
      if (firstAction === "finish") {
        fixture.callbacks.onResponseDone?.({ status: "completed" });
      } else {
        fixture.callbacks.onClearAudio();
      }
      for (let elapsed = 0; elapsed < 500; elapsed += 1) {
        await vi.advanceTimersByTimeAsync(1);
        await nextEventLoopTurn();
      }
      expect(heard).toEqual(firstAction === "finish" ? ["first", "second"] : ["second"]);
      expect(fixture.onTerminalError).not.toHaveBeenCalled();
      expect(next.onTerminalError).not.toHaveBeenCalled();
    } finally {
      fixture.close();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  },
);
