import { describe, expect, it } from "vitest";
import {
  calculatePlayedAudioMs,
  PlaybackClock,
  resolvePlaybackMediaTimestamp,
  schedulePlaybackSegment,
} from "../src/playback-clock.js";

describe("FaceTime playback clock", () => {
  it("tracks only audio that should have reached Core Audio", () => {
    const first = schedulePlaybackSegment({
      audioDurationMs: 100,
      generatedAudioMs: 0,
      nowMs: 1000,
      playbackUntilMs: 0,
    });
    const afterUnderrun = schedulePlaybackSegment({
      audioDurationMs: 100,
      generatedAudioMs: first.audioEndMs,
      nowMs: 1300,
      playbackUntilMs: first.wallEndMs,
    });
    const segments = [first, afterUnderrun];

    expect(calculatePlayedAudioMs({ nowMs: 1050, segments })).toBe(0);
    expect(calculatePlayedAudioMs({ nowMs: 1350, segments })).toBe(100);
    expect(calculatePlayedAudioMs({ nowMs: 1450, segments })).toBe(150);
    expect(calculatePlayedAudioMs({ nowMs: 2000, segments })).toBe(200);
  });

  it("resets the audible timeline when queued output is cleared", () => {
    const clock = new PlaybackClock();
    clock.append(4_800, 1000);
    expect(clock.playedAudioMs(1200)).toBe(100);
    clock.reset();
    expect(clock.playedAudioMs(1200)).toBe(0);
  });

  it("keeps cumulative output while exposing the remaining playback tail", () => {
    const clock = new PlaybackClock();
    clock.append(4_800, 1000);
    expect(clock.totalGeneratedAudioMs()).toBe(100);
    expect(clock.queuedAudioMs(1050)).toBe(100);
    expect(clock.millisecondsUntilDrained(1050)).toBe(150);
    expect(clock.queuedAudioMs(1150)).toBe(50);
    expect(clock.queuedAudioMs(1200)).toBe(0);
  });

  it("fully drains PCM chunks with fractional millisecond duration", () => {
    const clock = new PlaybackClock();
    clock.append(49, 1000);

    expect(clock.totalGeneratedAudioMs()).toBeCloseTo(49 / 48);
    expect(clock.queuedAudioMs(1200)).toBe(0);
  });

  it("converts played output into the provider media timeline for barge-in", () => {
    expect(
      resolvePlaybackMediaTimestamp({ responseStartTimestampMs: 1_000, playedAudioMs: 312.8 }),
    ).toBe(1_312);
  });

  it("allows later responses to subtract their own cumulative baseline", () => {
    const clock = new PlaybackClock();
    clock.append(4_800, 1000);
    const secondResponseBaseline = clock.totalGeneratedAudioMs();
    clock.append(9_600, 1300);

    expect(clock.playedAudioMs(1450) - secondResponseBaseline).toBe(50);
  });
});
