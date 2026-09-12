import { expect, it, vi } from "vitest";
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

it.each([20, 100])(
  "plays and retires a %i ms continuous reply without response completion",
  async (audioMs) => {
    const fixture = createRealtimePlaybackFixture(undefined, { outputAudioMode: "continuous" });
    try {
      fixture.playback.enqueueExactSpeechMessage("first answer");
      fixture.playback.enqueueExactSpeechMessage("next answer");
      fixture.callbacks.onAudio(pcmTone(audioMs, 32));
      fixture.callbacks.onMark?.("heard", () => fixture.acknowledgeMark("heard"));
      expect(fixture.player.state.status).not.toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
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
  try {
    fixture.callbacks.onAudio(pcmTone(500));
    fixture.callbacks.onMark?.("discarded", () => fixture.acknowledgeMark("discarded"));
    fixture.callbacks.onClearAudio();
    expect(fixture.player.state.status).toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);

    fixture.callbacks.onAudio(pcmTone(500));
    fixture.callbacks.onMark?.("heard", () => fixture.acknowledgeMark("heard"));
    expect(fixture.player.state.status).not.toBe(fixture.voiceSdk.AudioPlayerStatus.Idle);
    await vi.waitFor(() => expect(fixture.acknowledgeMark.mock.calls).toEqual([["heard"]]));
    expect(fixture.onTerminalError).not.toHaveBeenCalled();
  } finally {
    fixture.close();
  }
});

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
    try {
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
      lane.callbacks.onMark?.("last", recordProgress);
      expect(consumed).toEqual([]);
      if (position === "queued") {
        fixture.callbacks.onClearAudio();
      }
      await vi.waitFor(() => expect(consumed).toHaveLength(2));
      expect(consumed).toEqual([
        { opusMs: 100, pcmMs: 100 },
        { opusMs: 700, pcmMs: 700 },
      ]);
      expect(lane.onTerminalError).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
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
