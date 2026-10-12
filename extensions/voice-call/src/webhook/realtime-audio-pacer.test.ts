// Voice Call tests cover realtime audio pacer plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

type RealtimeAudioSerializer = ConstructorParameters<typeof RealtimeAudioPacer>[0]["serializer"];

function createTwilioSerializer(streamSid: string): RealtimeAudioSerializer {
  return {
    serializeMedia: (payload) => JSON.stringify({ event: "media", streamSid, media: { payload } }),
    serializeClear: () => JSON.stringify({ event: "clear", streamSid }),
    serializeMark: (name) => JSON.stringify({ event: "mark", streamSid, mark: { name } }),
  };
}

function createCompactSerializer(): RealtimeAudioSerializer {
  return {
    serializeMedia: (payload) => payload,
    serializeClear: () => "clear",
    serializeMark: (name) => `mark:${name}`,
  };
}

function createSequencedAudio(frameCount: number): Buffer {
  const audio = Buffer.alloc(frameCount * 160);
  for (let index = 0; index < frameCount; index += 1) {
    audio.fill(index % 256, index * 160, (index + 1) * 160);
  }
  return audio;
}

function inspectQueue(pacer: RealtimeAudioPacer): { length: number; head: number } {
  const state = pacer as unknown as { queue: unknown[]; queueHead: number };
  return { length: state.queue.length, head: state.queueHead };
}

function readSentMarks(sent: string[]): { name: string; audioEndMs: number }[] {
  let audioEndMs = 0;
  const marks: { name: string; audioEndMs: number }[] = [];
  for (const message of sent) {
    if (message.startsWith("mark:")) {
      marks.push({ name: message.slice("mark:".length), audioEndMs });
    } else if (message === "clear") {
      audioEndMs = 0;
    } else {
      audioEndMs += Buffer.from(message, "base64").length / 8;
    }
  }
  return marks;
}

function sentMarkAt(sent: string[], audioEndMs: number): string {
  const mark = readSentMarks(sent).find((entry) => entry.audioEndMs === audioEndMs);
  if (!mark) {
    throw new Error(`No sent carrier mark follows ${audioEndMs} ms of audio`);
  }
  return mark.name;
}

describe("RealtimeAudioPacer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches up all overdue frames when a pump runs late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(50));
    expect(sent).toHaveLength(8);

    now = 100;
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveLength(13);
  });

  it("stops instead of buffering unbounded realtime audio", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const onBackpressure = vi.fn();
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      maxQueuedAudioBytes: 320,
      onBackpressure,
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(480, 0x7f));
    pacer.sendMark("after-overflow");
    await vi.advanceTimersByTimeAsync(100);

    expect(onBackpressure).toHaveBeenCalledOnce();
    expect(sent).toStrictEqual([]);
  });

  it("drains the full default audio backlog in order and resets queue storage", async () => {
    vi.useFakeTimers();
    const frameCount = 6_000;
    const sentFrames: number[] = [];
    const sentMarks: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        if (message.startsWith("mark:")) {
          sentMarks.push(message);
        } else {
          sentFrames.push(Buffer.from(message, "base64")[0] ?? -1);
        }
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(frameCount));
    pacer.sendMark("complete");
    await vi.advanceTimersByTimeAsync(frameCount * 20);

    expect(sentFrames).toEqual(Array.from({ length: frameCount }, (_, index) => index % 256));
    expect(sentMarks).toEqual(["mark:complete"]);
    expect(inspectQueue(pacer)).toEqual({ length: 0, head: 0 });
    expect(pacer.hasPendingAudio()).toBe(false);
  });
});

describe("RealtimeAudioPacer playout state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createPlaybackPacer() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    return { pacer, sent };
  }

  it("drops playout state when queued audio is cleared or closed", async () => {
    const { pacer } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(400);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    pacer.clearAudio();
    expect(pacer.getPlaybackState()).toEqual([]);

    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-b" });
    pacer.close();
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("fires the playback reset hook on every clear and close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const onPlaybackReset = vi.fn();
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      onPlaybackReset,
      send: () => true,
    });

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    pacer.clearAudio();
    expect(onPlaybackReset).toHaveBeenCalledTimes(1);

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-b" });
    pacer.close();
    expect(onPlaybackReset).toHaveBeenCalledTimes(2);
  });

  it("reports one cumulative offset when an item resumes after another item", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-b" });
    pacer.sendAudio(createSequencedAudio(10), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(300);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 0 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));

    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 160 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    await vi.advanceTimersByTimeAsync(860);
    pacer.acknowledgeMark(sentMarkAt(sent, 1120));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 720 }]);
  });

  it("does not retire an unfinished item when the carrier catches up to a delayed pump", async () => {
    const { pacer, sent } = createPlaybackPacer();
    const stalledClock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
      const mark = sentMarkAt(sent, 160);

      // The carrier plays the sent lead while the pump has no new clock tick.
      await vi.advanceTimersByTimeAsync(160);
      expect(sent.filter((message) => !message.startsWith("mark:"))).toHaveLength(8);
      pacer.acknowledgeMark(mark);

      expect(pacer.hasPendingAudio()).toBe(true);
      expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 160 }]);
    } finally {
      pacer.close();
      stalledClock.mockRestore();
    }
  });

  it("ignores a delayed progress receipt after clear when the same item resumes", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(160);
    const oldMark = sentMarkAt(sent, 160);
    pacer.clearAudio();
    pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
    pacer.acknowledgeMark(oldMark);

    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);
  });
});

describe("RealtimeAudioPacer playback retention", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createRetentionPolicyPacer() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: string[] = [];
    const onBackpressure = vi.fn();
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      onBackpressure,
      send: (message) => {
        sent.push(message);
        return true;
      },
    });
    return { pacer, sent, onBackpressure };
  }

  it("does not evict fully sent segments without receipts after elapsed playout time", async () => {
    const { pacer, onBackpressure } = createRetentionPolicyPacer();

    for (let index = 1; index <= 128; index += 1) {
      pacer.sendAudio(createSequencedAudio(1), { itemId: `item-${index}` });
    }
    await vi.advanceTimersByTimeAsync(128 * 20 + 500);
    expect(pacer.hasPendingAudio()).toBe(false);
    expect(pacer.getPlaybackState()).toEqual(
      Array.from({ length: 128 }, (_, index) => ({
        itemId: `item-${index + 1}`,
        audioEndMs: 0,
      })),
    );

    pacer.sendAudio(createSequencedAudio(1), { itemId: "item-129" });
    expect(onBackpressure).toHaveBeenCalledOnce();
    expect(pacer.hasPendingAudio()).toBe(false);
  });

  it("reuses retention capacity only after receipts confirm completed prefixes", async () => {
    const { pacer, sent, onBackpressure } = createRetentionPolicyPacer();

    for (let index = 1; index <= 128; index += 1) {
      pacer.sendAudio(createSequencedAudio(1), { itemId: `item-${index}` });
    }
    await vi.advanceTimersByTimeAsync(128 * 20 + 500);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));

    expect(pacer.getPlaybackState()).toHaveLength(120);
    expect(pacer.getPlaybackState().at(0)).toEqual({ itemId: "item-9", audioEndMs: 0 });
    for (let index = 129; index <= 136; index += 1) {
      pacer.sendAudio(createSequencedAudio(1), { itemId: `item-${index}` });
    }
    expect(onBackpressure).not.toHaveBeenCalled();
    expect(pacer.getPlaybackState()).toHaveLength(128);
    expect(pacer.getPlaybackState().at(-1)).toEqual({ itemId: "item-136", audioEndMs: 0 });

    pacer.sendAudio(createSequencedAudio(1), { itemId: "item-137" });
    expect(onBackpressure).toHaveBeenCalledOnce();
  });
});
