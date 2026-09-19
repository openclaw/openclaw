import type { AudioResource } from "@discordjs/voice";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { createRealtimePlaybackFixture } from "./realtime-playback.integration.test-support.js";

function pcmTone(audioMs: number, amplitude = 4_000): Buffer {
  const pcm = Buffer.alloc(audioMs * 48);
  for (let sample = 0; sample < pcm.length / 2; sample += 1) {
    pcm.writeInt16LE(
      Math.round(amplitude * Math.sin((sample * 2 * Math.PI * 440) / 24_000)),
      sample * 2,
    );
  }
  return pcm;
}

it.each([10, 20, 100])(
  "plays and retires a %i ms continuous reply without response completion",
  async (audioMs) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
    try {
      fixture.playback.enqueueExactSpeechMessage("first answer");
      fixture.playback.enqueueExactSpeechMessage("next answer");
      fixture.callbacks.onAudio(pcmTone(audioMs, 32));
      fixture.callbacks.onMark?.("heard", () => fixture.acknowledgeMark("heard"));
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Playing,
        4_000,
      );
      await vi.waitFor(() => expect(fixture.acknowledgeMark).toHaveBeenCalledWith("heard"));
      expect(fixture.sendUserMessage.mock.calls).toEqual([["first answer"]]);
      await fixture.voiceSdk.entersState(
        fixture.player,
        fixture.voiceSdk.AudioPlayerStatus.Idle,
        4_000,
      );
      expect(fixture.sendUserMessage.mock.calls).toEqual([["first answer"], ["next answer"]]);
      expect(fixture.playback.isOutputAudioActive()).toBe(false);
      expect(fixture.onTerminalError).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  },
);

it("resumes continuous output after the provider clears unplayed PCM", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const heard = createDeferred<void>();
  try {
    fixture.callbacks.onAudio(pcmTone(500));
    fixture.callbacks.onMark?.("discarded", () => fixture.acknowledgeMark("discarded"));
    fixture.callbacks.onClearAudio();
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);

    fixture.callbacks.onAudio(pcmTone(500));
    fixture.callbacks.onMark?.("heard", () => {
      fixture.acknowledgeMark("heard");
      heard.resolve();
    });
    expect(fixture.player.state.status).not.toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    await vi.waitFor(() => heard.promise, { timeout: 1_000 });
    expect(fixture.acknowledgeMark.mock.calls).toEqual([["heard"]]);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});

it("plays continuous audio arriving during the player's starvation retirement", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const resources = new Set<AudioResource>();
  fixture.player.on("stateChange", (_previous, state) => {
    if (state.status !== fixture.voiceSdk.AudioPlayerStatus.Idle) {
      resources.add(state.resource);
    }
  });
  const stop = fixture.voiceSdk.AudioPlayer.prototype.stop.bind(fixture.player);
  let resumed = false;
  fixture.stop.mockImplementation((force) => {
    const stopped = stop(force);
    if (!force && !resumed) {
      resumed = true;
      // The SDK still plays five silence packets after its natural starvation stop.
      fixture.callbacks.onAudio(pcmTone(100));
    }
    return stopped;
  });
  try {
    fixture.callbacks.onAudio(pcmTone(120));
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Playing,
      4_000,
    );
    await vi.waitFor(() => expect(fixture.playback.isOutputAudioActive()).toBe(false), {
      // A successor resource may need its own two-second starvation retirement.
      timeout: 6_000,
    });
    expect(resumed).toBe(true);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(
      Array.from(resources).reduce((total, resource) => total + resource.playbackDuration, 0),
    ).toBe(220);
  } finally {
    fixture.close();
  }
});

it.each([
  { pauseMs: 240, resumeAfterMs: 0 },
  { pauseMs: 2_400, resumeAfterMs: 2_100 },
])(
  "preserves a $pauseMs ms continuous pause after preceding speech was consumed",
  async ({ pauseMs, resumeAfterMs }) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
    const playbackComplete = createDeferred<void>();
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const resources = new Set<AudioResource>();
    fixture.player.on("stateChange", (_previous, state) => {
      if (state.status !== fixture.voiceSdk.AudioPlayerStatus.Idle) {
        resources.add(state.resource);
      }
    });
    onTestFinished(() => {
      clearTimeout(resumeTimer);
      fixture.player.off("error", playbackComplete.reject);
      fixture.close();
    });
    fixture.player.once("error", playbackComplete.reject);
    fixture.onTerminalError.mockImplementation(playbackComplete.reject);
    fixture.callbacks.onAudio(pcmTone(120));
    fixture.callbacks.onMark?.("first", () => {
      fixture.callbacks.onAudio(Buffer.alloc(pauseMs * 48));
      const resume = () => {
        fixture.callbacks.onAudio(pcmTone(120));
        fixture.callbacks.onMark?.("last", playbackComplete.resolve);
      };
      if (resumeAfterMs > 0) {
        // Resume while the quiet output is draining PCM accepted before its idle deadline.
        resumeTimer = setTimeout(resume, resumeAfterMs);
      } else {
        resume();
      }
    });
    await playbackComplete.promise;
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(
      Array.from(resources).reduce((total, resource) => total + resource.playbackDuration, 0),
    ).toBe(pauseMs + 240);
  },
);

it("leaves continuous interruption to the provider even when Discord barge-in is enabled", () => {
  const fixture = createRealtimePlaybackFixture(undefined, {
    outputAudioMode: "continuous",
    bargeIn: true,
  });
  const lane = fixture.createLane("clear");
  try {
    lane.callbacks.onAudio(pcmTone(500));
    fixture.roomPlayer.handleBargeIn("speaker-start");
    expect(lane.cancel).not.toHaveBeenCalled();
    expect(fixture.player.state.status).not.toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    lane.callbacks.onClearAudio();
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
  } finally {
    fixture.close();
  }
});

it("releases continuous playback to another speaker while transport silence keeps arriving", async () => {
  const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
  const next = fixture.createLane();
  const silence = pcmTone(20, 8);
  const silentFrames = setInterval(() => fixture.callbacks.onAudio(silence), 20);
  try {
    fixture.callbacks.onAudio(silence);
    expect(fixture.playback.isOutputAudioActive()).toBe(false);
    fixture.callbacks.onAudio(pcmTone(100));
    next.callbacks.onAudio(pcmTone(100));
    next.callbacks.onMark?.("heard", () => next.acknowledgeMark("heard"));
    await vi.waitFor(() => expect(next.acknowledgeMark).toHaveBeenCalledWith("heard"), {
      timeout: 4_000,
    });
    expect(fixture.playback.isOutputAudioActive()).toBe(false);
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(next.onTerminalError).not.toHaveBeenCalled();
  } finally {
    clearInterval(silentFrames);
    fixture.close();
  }
});

it.each(["queued", "backlogged"] as const)(
  "preserves pauses inside %s continuous speech",
  async (position) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
    const lane = position === "queued" ? fixture.createLane() : fixture;
    const playbackComplete = createDeferred<void>();
    onTestFinished(() => {
      fixture.player.off("error", playbackComplete.reject);
      fixture.close();
    });
    fixture.player.once("error", playbackComplete.reject);
    fixture.onTerminalError.mockImplementation(playbackComplete.reject);
    lane.onTerminalError.mockImplementation(playbackComplete.reject);
    if (position === "queued") {
      fixture.callbacks.onAudio(pcmTone(500));
    }
    const consumed: Array<{ opusMs: number; pcmMs: number | undefined }> = [];
    const recordProgress = () => {
      const state = fixture.player.state;
      if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
        throw new Error("expected continuous speech playback");
      }
      consumed.push({
        opusMs: state.resource.playbackDuration,
        pcmMs: lane.callbacks.getPlaybackState?.()[0]?.audioEndMs,
      });
    };
    lane.callbacks.onAudio(pcmTone(100), { itemId: "speech" });
    lane.callbacks.onMark?.("first", recordProgress);
    lane.callbacks.onAudio(Buffer.alloc(500 * 48), { itemId: "speech" });
    lane.callbacks.onAudio(pcmTone(100), { itemId: "speech" });
    lane.callbacks.onMark?.("last", () => {
      recordProgress();
      playbackComplete.resolve();
    });
    expect(consumed).toEqual([]);
    if (position === "queued") {
      fixture.callbacks.onClearAudio();
    }
    await playbackComplete.promise;
    expect(consumed).toEqual([
      { opusMs: 100, pcmMs: 100 },
      { opusMs: 700, pcmMs: 700 },
    ]);
    expect(lane.onTerminalError).not.toHaveBeenCalled();
  },
);

it("keeps PCM marks truthful across repeated partial-frame underflows", async () => {
  const fixture = createRealtimePlaybackFixture();
  try {
    fixture.callbacks.onAudio(Buffer.alloc(24_480), { itemId: "resumed" });
    const state = fixture.player.state;
    if (state.status === fixture.voiceSdk.AudioPlayerStatus.Idle) {
      throw new Error("expected response resource");
    }
    const consumed: Array<{ opusMs: number; pcmMs: number | undefined }> = [];
    const recordProgress = () => {
      consumed.push({
        opusMs: state.resource.playbackDuration,
        pcmMs: fixture.callbacks.getPlaybackState?.()[0]?.audioEndMs,
      });
    };
    fixture.callbacks.onMark?.("first", () => {
      recordProgress();
      fixture.callbacks.onAudio(Buffer.alloc(24_480), { itemId: "resumed" });
      fixture.callbacks.onMark?.("second", () => {
        recordProgress();
        fixture.callbacks.onResponseDone?.({ status: "completed" });
      });
    });
    await fixture.voiceSdk.entersState(
      fixture.player,
      fixture.voiceSdk.AudioPlayerStatus.Idle,
      4_000,
    );
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
    expect(consumed).toEqual([
      { opusMs: 520, pcmMs: 510 },
      { opusMs: 1_040, pcmMs: 1_020 },
    ]);
  } finally {
    fixture.close();
  }
});
