import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdleCheckIn,
  REALTIME_IDLE_CHECK_IN_LINE,
  REALTIME_IDLE_GOODBYE_LINE,
} from "./realtime-idle-check-in.js";

function setup(options: { noBridge?: boolean } = {}) {
  let playingUntil = 0;
  let closed = false;
  const said: string[] = [];
  const hangUp = vi.fn();
  const restartIdle = vi.fn();
  const checkIn = createIdleCheckIn({
    callId: "call-1",
    providerCallId: "CA-1",
    idleHangupMs: 1_000,
    audioPacer: { hasPlaybackAudio: (tailMs = 0) => Date.now() < playingUntil + tailMs },
    say: (instructions) => {
      if (options.noBridge) {
        throw new Error("No active realtime bridge for call");
      }
      said.push(instructions);
    },
    isClosed: () => closed,
    restartIdle,
    hangUp,
  });
  /** The line the model was last asked to say. */
  const lastLine = () => said.at(-1)?.split("Line: ")[1];
  const play = (ms: number) => {
    playingUntil = Date.now() + ms;
    checkIn.noteAudibleOutput();
  };
  /** Checks in, then starts the goodbye and plays two seconds of it. */
  const startGoodbye = () => {
    checkIn.onIdle();
    checkIn.onIdle();
    play(2_000);
  };
  const close = () => {
    closed = true;
  };
  return { checkIn, said, hangUp, restartIdle, lastLine, play, startGoodbye, close };
}

describe("createIdleCheckIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks in on the first silence and hangs up only after the goodbye and a pause", async () => {
    const { checkIn, said, hangUp, restartIdle, lastLine, play } = setup();
    checkIn.onIdle();
    expect(lastLine()).toBe(REALTIME_IDLE_CHECK_IN_LINE);
    expect(said[0]).toContain("Say exactly the following line and nothing else.");
    expect(restartIdle).toHaveBeenCalledOnce();
    checkIn.onIdle();
    expect(lastLine()).toBe(REALTIME_IDLE_GOODBYE_LINE);
    play(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it("checks in again once the caller has spoken, up to three times per call", () => {
    const { checkIn, said, lastLine } = setup();
    for (let round = 0; round < 3; round += 1) {
      checkIn.onIdle();
      expect(lastLine()).toBe(REALTIME_IDLE_CHECK_IN_LINE);
      checkIn.noteCallerSpeech();
    }
    checkIn.onIdle();
    expect(lastLine()).toBe(REALTIME_IDLE_GOODBYE_LINE);
    expect(said).toHaveLength(4);
  });

  it("keeps the call for a caller who speaks up during the goodbye or the pause after it", async () => {
    const { checkIn, hangUp, restartIdle, lastLine, startGoodbye } = setup();
    startGoodbye();
    await vi.advanceTimersByTimeAsync(1_000);
    checkIn.noteCallerSpeech();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hangUp).not.toHaveBeenCalled();
    expect(restartIdle).toHaveBeenCalledTimes(2);
    // The goodbye has played; "wait, I'm here" in the pause after it still counts.
    startGoodbye();
    await vi.advanceTimersByTimeAsync(4_000);
    checkIn.noteCallerSpeech();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hangUp).not.toHaveBeenCalled();
    checkIn.onIdle();
    expect(lastLine()).toBe(REALTIME_IDLE_CHECK_IN_LINE);
  });

  it("keeps at most two talked-over goodbyes per call, bounding echo or noise loops", async () => {
    const { checkIn, hangUp, startGoodbye } = setup();
    for (let round = 0; round < 3; round += 1) {
      startGoodbye();
      await vi.advanceTimersByTimeAsync(500);
      checkIn.noteCallerSpeech();
      await vi.advanceTimersByTimeAsync(6_000);
    }
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it("abandons a goodbye that never finishes playing, or never starts", async () => {
    const endless = setup();
    endless.checkIn.onIdle();
    endless.checkIn.onIdle();
    endless.play(60_000);
    const silent = setup();
    silent.checkIn.onIdle();
    silent.checkIn.onIdle();
    await vi.advanceTimersByTimeAsync(9_900);
    expect(endless.hangUp).not.toHaveBeenCalled();
    expect(silent.hangUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(endless.hangUp).toHaveBeenCalledOnce();
    expect(silent.hangUp).toHaveBeenCalledOnce();
  });

  it("hangs up at once without a bridge to say the goodbye", async () => {
    const { checkIn, hangUp, restartIdle } = setup({ noBridge: true });
    checkIn.onIdle();
    expect(restartIdle).toHaveBeenCalledOnce();
    checkIn.onIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(hangUp).toHaveBeenCalledOnce();
  });

  it("ignores silence while the goodbye is under way, and stops when the call closes", async () => {
    const { checkIn, said, hangUp, startGoodbye, close } = setup();
    startGoodbye();
    checkIn.onIdle();
    expect(said).toHaveLength(2);
    close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hangUp).not.toHaveBeenCalled();
  });
});
