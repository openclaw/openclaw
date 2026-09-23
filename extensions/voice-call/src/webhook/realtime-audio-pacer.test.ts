// Voice Call tests cover realtime audio pacer plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

type RealtimeAudioSerializer = ConstructorParameters<typeof RealtimeAudioPacer>[0]["serializer"];

function createTwilioSerializer(streamSid: string): RealtimeAudioSerializer {
  return {
    media: (payload) => JSON.stringify({ event: "media", streamSid, media: { payload } }),
    clear: () => JSON.stringify({ event: "clear", streamSid }),
    mark: (name) => JSON.stringify({ event: "mark", streamSid, mark: { name } }),
  };
}

function createTelnyxSerializer(): RealtimeAudioSerializer {
  return {
    media: (payload) => JSON.stringify({ event: "media", media: { payload } }),
    clear: () => JSON.stringify({ event: "clear" }),
    mark: (name) => JSON.stringify({ event: "mark", mark: { name } }),
  };
}

function createCompactSerializer(): RealtimeAudioSerializer {
  return {
    media: (payload) => payload,
    clear: () => "clear",
    mark: (name) => `mark:${name}`,
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

  it("primes an eight-frame lead and then advances without timer drift", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(50 * 160, 0x7f));

    expect(sent).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(13);
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

  it("starts a fresh lead window after a genuine silence gap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(5));
    expect(sent).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(500);
    pacer.sendAudio(createSequencedAudio(20));
    expect(sent).toHaveLength(13);
  });

  it("preserves marks after the audio they follow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(10));
    pacer.sendMark("audio-1");
    pacer.sendMark("audio-2");
    await vi.advanceTimersByTimeAsync(100);

    expect(sent.slice(-2)).toEqual(["mark:audio-1", "mark:audio-2"]);
  });

  it("clears queued audio immediately (Twilio shape)", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTwilioSerializer("MZ-test"),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(480, 0x7f));
    pacer.clearAudio();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual({ event: "clear", streamSid: "MZ-test" });
  });

  it("closes without sending the remaining lead-window backlog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(20));
    pacer.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(8);
    expect(pacer.hasPendingAudio()).toBe(false);
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

  it("paces audio in Telnyx envelope shape (no streamSid)", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createTelnyxSerializer(),
      send: (message) => {
        sent.push(JSON.parse(message));
        return true;
      },
    });

    pacer.sendAudio(Buffer.alloc(160, 0x7f));
    pacer.clearAudio();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toEqual([
      { event: "media", media: { payload: Buffer.alloc(160, 0x7f).toString("base64") } },
      { event: "clear" },
    ]);
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

  it("compacts a long queue while preserving pending bytes through clear", async () => {
    vi.useFakeTimers();
    const frameCount = 800;
    const sent: string[] = [];
    const pacer = new RealtimeAudioPacer({
      serializer: createCompactSerializer(),
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    pacer.sendAudio(createSequencedAudio(frameCount));
    await vi.advanceTimersByTimeAsync(500 * 20);

    expect(sent).toHaveLength(508);
    expect(inspectQueue(pacer)).toEqual({ length: 399, head: 107 });
    expect(pacer.clearAudio()).toBe(292 * 160);
    await vi.advanceTimersByTimeAsync(frameCount * 20);

    expect(sent).toHaveLength(509);
    expect(sent.at(-1)).toBe("clear");
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

  it("reports zero until carrier receipts confirm a retained item's played prefix", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-b" });

    // Lead-window audio has not played out yet; queued items report zero.
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 0 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    await vi.advanceTimersByTimeAsync(600);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 0 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    pacer.acknowledgeMark(sentMarkAt(sent, 480));
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 480 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pacer.hasPendingAudio()).toBe(false);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 480 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);
    pacer.acknowledgeMark(sentMarkAt(sent, 960));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-b", audioEndMs: 360 }]);
  });

  it("merges consecutive chunks of the same provider item", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(4), { itemId: "item-a" });
    pacer.sendAudio(createSequencedAudio(6), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(1_000);

    pacer.acknowledgeMark(sentMarkAt(sent, 160));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 160 }]);
  });

  it("reports one cumulative offset when an item resumes after another item", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(30), { itemId: "item-a" });
    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-b" });
    pacer.sendAudio(createSequencedAudio(10), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(300);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));

    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 160 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    await vi.advanceTimersByTimeAsync(860);
    pacer.acknowledgeMark(sentMarkAt(sent, 1120));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 720 }]);
  });

  it("consumes playout time for untracked audio without reporting it", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(10));
    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(1_000);

    const mark = readSentMarks(sent).find((entry) => entry.audioEndMs > 200);
    if (!mark) {
      throw new Error("No progress mark follows the anonymous audio prefix");
    }
    pacer.acknowledgeMark(mark.name);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: mark.audioEndMs - 200 },
    ]);
  });

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

  it("keeps the drained carrier lead unconfirmed until its played mark arrives", async () => {
    const { pacer, sent } = createPlaybackPacer();

    // One lead window drains synchronously; the carrier edge still buffers it.
    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    expect(pacer.hasPendingAudio()).toBe(false);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    await vi.advanceTimersByTimeAsync(80);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    await vi.advanceTimersByTimeAsync(80);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("retires carrier-acknowledged playback before the next interruption", async () => {
    const { pacer } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-a" });
    pacer.sendMark("item-a-done");
    pacer.sendAudio(createSequencedAudio(10), { itemId: "item-b" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 0 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    // Carrier confirms playout reached the mark: item-a leaves the snapshot so a
    // later interruption of item-b cannot truncate it again.
    pacer.acknowledgeMark("item-a-done");
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-b", audioEndMs: 0 }]);
  });

  it("treats a carrier mark acknowledgement as playout confirmation", async () => {
    const { pacer } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    pacer.sendMark("item-a-done");
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    await vi.advanceTimersByTimeAsync(160);
    pacer.acknowledgeMark("item-a-done");
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("ignores acknowledgements for unknown marks", async () => {
    const { pacer } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    pacer.sendMark("item-a-done");

    pacer.acknowledgeMark("never-sent");
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);
  });

  it("preserves cumulative item progress across chunk acknowledgements", async () => {
    const { pacer } = createPlaybackPacer();

    // Providers emit a mark after every audio delta, so an item can be
    // acknowledged and then resume with more audio under the same item id.
    pacer.sendAudio(createSequencedAudio(5), { itemId: "item-a" });
    pacer.sendMark("chunk-1");
    pacer.sendAudio(createSequencedAudio(5), { itemId: "item-a" });
    pacer.sendMark("chunk-2");
    await vi.advanceTimersByTimeAsync(1_000);

    pacer.acknowledgeMark("chunk-1");
    pacer.acknowledgeMark("chunk-2");
    expect(pacer.getPlaybackState()).toEqual([]);

    // Generation resumes for the same item: the snapshot continues from the
    // acknowledged offset instead of restarting at zero.
    pacer.sendAudio(createSequencedAudio(3), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 200 }]);
  });

  it("retires every retained prefix confirmed by one mark", async () => {
    const { pacer } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(5), { itemId: "item-a" });
    pacer.sendAudio(createSequencedAudio(5), { itemId: "item-b" });
    pacer.sendMark("both-played");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pacer.getPlaybackState()).toEqual([
      { itemId: "item-a", audioEndMs: 0 },
      { itemId: "item-b", audioEndMs: 0 },
    ]);

    pacer.acknowledgeMark("both-played");
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("confirms only the first short burst when a later burst is still unacknowledged", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(80);
    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });

    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    await vi.advanceTimersByTimeAsync(240);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 160 }]);
    pacer.acknowledgeMark(sentMarkAt(sent, 320));
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("keeps queued frames attached to their item after a partial progress receipt", async () => {
    const { pacer, sent } = createPlaybackPacer();

    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-a" });
    await vi.advanceTimersByTimeAsync(80);
    pacer.sendAudio(createSequencedAudio(20), { itemId: "item-a" });
    expect(pacer.hasPendingAudio()).toBe(true);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 0 }]);

    await vi.advanceTimersByTimeAsync(80);
    pacer.acknowledgeMark(sentMarkAt(sent, 160));
    expect(pacer.hasPendingAudio()).toBe(true);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 160 }]);

    await vi.advanceTimersByTimeAsync(400);
    pacer.acknowledgeMark(sentMarkAt(sent, 480));
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-a", audioEndMs: 480 }]);
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

  it("tears down through backpressure instead of evicting a queued item at the retention limit", async () => {
    const { pacer, onBackpressure } = createRetentionPolicyPacer();

    // A 2,000 ms playing item followed by 127 distinct 20 ms items fills the
    // 128-segment retention bound while staying far below the byte limit.
    pacer.sendAudio(createSequencedAudio(100), { itemId: "item-1" });
    for (let index = 2; index <= 128; index += 1) {
      pacer.sendAudio(createSequencedAudio(1), { itemId: `item-${index}` });
    }

    // The playing item keeps its identity: the snapshot still reports it.
    expect(onBackpressure).not.toHaveBeenCalled();
    expect(pacer.getPlaybackState().at(0)).toEqual({ itemId: "item-1", audioEndMs: 0 });

    // The 129th distinct item cannot be admitted because the oldest segment
    // still has unsent queued frames, so the pacer must fail loudly through
    // the existing backpressure path instead of silently dropping identity.
    pacer.sendAudio(createSequencedAudio(1), { itemId: "item-129" });
    expect(onBackpressure).toHaveBeenCalledOnce();
    expect(pacer.hasPendingAudio()).toBe(false);
    expect(pacer.getPlaybackState()).toEqual([]);
  });

  it("keeps a fully sent but unplayed lead item live at the retention limit", async () => {
    const { pacer, onBackpressure } = createRetentionPolicyPacer();

    // The first item drains synchronously into the carrier lead window: every
    // frame is sent, but none of it can have played out yet.
    pacer.sendAudio(createSequencedAudio(8), { itemId: "item-1" });
    expect(pacer.hasPendingAudio()).toBe(false);
    expect(pacer.getPlaybackState()).toEqual([{ itemId: "item-1", audioEndMs: 0 }]);

    for (let index = 2; index <= 128; index += 1) {
      pacer.sendAudio(createSequencedAudio(1), { itemId: `item-${index}` });
    }

    pacer.sendAudio(createSequencedAudio(1), { itemId: "item-129" });
    expect(onBackpressure).toHaveBeenCalledOnce();
  });

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
