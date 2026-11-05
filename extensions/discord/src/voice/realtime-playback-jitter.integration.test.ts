import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { AudioResource } from "@discordjs/voice";
import { loadLibopus } from "libopus-wasm";
import { expect, it, onTestFinished, vi } from "vitest";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

// Timing needs 20 ms of audible PCM16, not a particular frequency or phase.
const tone = () => Buffer.alloc(960, Buffer.from([0xa0, 0x0f, 0xa0, 0x0f, 0x60, 0xf0, 0x60, 0xf0]));

async function createJitterFixture() {
  await loadLibopus();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  onTestFinished(() => {
    fixture.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return fixture;
}

async function tick(ms: number, done = () => false) {
  for (let elapsed = 0; elapsed < ms && !done(); elapsed++) {
    await vi.advanceTimersByTimeAsync(1);
    // The real encoder yields between packet-clock ticks.
    await nextEventLoopTurn();
  }
}

it("absorbs an 80 ms delivery reorder gap without inserting playback silence", async () => {
  const fixture = await createJitterFixture();
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
  let previousArrival = 0;
  for (let frame = 0; frame < 100; frame += 1) {
    const arrival = Math.max(previousArrival, frame * 20 + (frame % 20 === 5 ? 80 : 0));
    previousArrival = arrival;
    setTimeout(() => {
      fixture.callbacks.onAudio(tone(), { itemId: "reply" });
      if (frame === 99) {
        fixture.callbacks.onMark?.("complete", () => {
          consumedMs = fixture.callbacks.getPlaybackState?.()[0]?.audioEndMs;
          complete = true;
        });
      }
    }, arrival);
  }
  await tick(3_000, () => complete);
  expect([complete, consumedMs, missingFrames, resources.size]).toEqual([true, 2_000, 0, 1]);
  expect(fixture.onTerminalError).not.toHaveBeenCalled();
});

it("retires a short continuous reply before its startup deadline without late playback", async () => {
  const fixture = await createJitterFixture();
  const play = vi.spyOn(fixture.player, "play");
  fixture.callbacks.onAudio(tone());
  expect(play).not.toHaveBeenCalled();
  fixture.callbacks.onClearAudio();
  await vi.advanceTimersByTimeAsync(200);
  await nextEventLoopTurn();
  expect(play).not.toHaveBeenCalled();
  expect(fixture.playback.isOutputAudioActive()).toBe(false);
  expect(fixture.onTerminalError).not.toHaveBeenCalled();
});

it.each(["finish", "cancel"] as const)(
  "preserves room order when a later speaker fills preroll first (%s)",
  async (firstAction) => {
    const fixture = await createJitterFixture();
    const next = fixture.createLane();
    const heard: string[] = [];
    fixture.callbacks.onAudio(tone());
    fixture.callbacks.onMark?.("first", () => heard.push("first"));
    next.callbacks.onAudio(Buffer.concat(Array.from({ length: 6 }, tone)));
    next.callbacks.onMark?.("second", () => heard.push("second"));
    next.callbacks.onResponseDone?.({ status: "completed" });
    if (firstAction === "finish") {
      fixture.callbacks.onResponseDone?.({ status: "completed" });
    } else {
      fixture.callbacks.onClearAudio();
    }
    await tick(500);
    expect(heard).toEqual(firstAction === "finish" ? ["first", "second"] : ["second"]);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(next.onTerminalError).not.toHaveBeenCalled();
  },
);
