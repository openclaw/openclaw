import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

const LOUD_FRAME = Buffer.alloc(160, 0x00);
const TEST_TIMEOUT_MS = 15_000;

type CarrierFrame = {
  event?: string;
  mark?: { name?: string };
};

type ObservedCarrierFrames = CarrierFrame[] & {
  waitForFrame: (
    predicate: (frame: CarrierFrame, frames: readonly CarrierFrame[]) => boolean,
  ) => Promise<CarrierFrame>;
};

type ObservedProviderAudio = Buffer[] & {
  armForCount: (count: number) => Promise<void>;
  notify: () => void;
};

function isSilence(buffer: Buffer): boolean {
  return buffer.every((byte) => byte === 0xff);
}

function observeCarrierFrames(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
): ObservedCarrierFrames {
  const frames: CarrierFrame[] = [];
  const waiters = new Set<{
    predicate: (frame: CarrierFrame, frames: readonly CarrierFrame[]) => boolean;
    resolve: (frame: CarrierFrame) => void;
  }>();
  ws.on("message", (data: RawData) => {
    try {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const frame = JSON.parse(bytes.toString("utf8")) as CarrierFrame;
      frames.push(frame);
      for (const waiter of waiters) {
        if (waiter.predicate(frame, frames)) {
          waiters.delete(waiter);
          waiter.resolve(frame);
        }
      }
    } catch {
      // ignore non-JSON carrier frames
    }
  });
  return Object.assign(frames, {
    waitForFrame: (
      predicate: (frame: CarrierFrame, frames: readonly CarrierFrame[]) => boolean,
    ): Promise<CarrierFrame> => {
      const existingFrame = frames.find((frame) => predicate(frame, frames));
      if (existingFrame) {
        return Promise.resolve(existingFrame);
      }
      const deferred = createDeferred<CarrierFrame>();
      waiters.add({ predicate, resolve: deferred.resolve });
      return deferred.promise;
    },
  });
}

function observeProviderAudio(): ObservedProviderAudio {
  const audio: Buffer[] = [];
  const waiters = new Set<{ count: number; resolve: () => void }>();
  return Object.assign(audio, {
    armForCount: (count: number): Promise<void> => {
      if (audio.length >= count) {
        return Promise.resolve();
      }
      const deferred = createDeferred<void>();
      waiters.add({ count, resolve: deferred.resolve });
      return deferred.promise;
    },
    notify: (): void => {
      for (const waiter of waiters) {
        if (audio.length >= waiter.count) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
  });
}

function sendCallerAudio(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
  audio = LOUD_FRAME,
): void {
  ws.send(
    JSON.stringify({
      event: "media",
      media: { payload: audio.toString("base64") },
    }),
  );
}

async function expectCallerAudio(
  ws: Awaited<ReturnType<typeof connectCarrierStream>>["ws"],
  providerAudio: ObservedProviderAudio,
  expected: "audio" | "silence",
): Promise<void> {
  providerAudio.length = 0;
  const providerAudioReceived = providerAudio.armForCount(1);
  sendCallerAudio(ws);
  await providerAudioReceived;
  expect(providerAudio.every(isSilence)).toBe(expected === "silence");
}

function countPlayoutMarks(frames: readonly CarrierFrame[]): number {
  return frames.filter(
    (frame) => frame.event === "mark" && frame.mark?.name?.startsWith("openclaw-playout-"),
  ).length;
}

function findGreetingCompletionMark(frames: CarrierFrame[]): string | undefined {
  return frames.find(
    (frame) =>
      frame.event === "mark" && frame.mark?.name?.startsWith("openclaw-greeting-complete-"),
  )?.mark?.name;
}

describe("RealtimeCallHandler greeting protection", () => {
  it(
    "mutes caller audio to the provider while the opening greeting is protected",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-greet-mute", callSid: call.providerCallId },
        }),
      );
      const callbacks = await bridgeCreated.promise;
      callbacks.onReady?.();
      await expectCallerAudio(ws, providerAudio, "silence");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases caller audio when the greeting never produces audio",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-greet-stall", callSid: call.providerCallId },
        }),
      );
      const callbacks = await bridgeCreated.promise;
      callbacks.onReady?.();
      await expectCallerAudio(ws, providerAudio, "silence");

      // A completed greeting turn with no audio is terminal, so caller audio resumes immediately.
      callbacks.onResponseDone?.({ status: "completed", responseId: "greeting" });
      await expectCallerAudio(ws, providerAudio, "audio");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases caller audio without completing a cancelled greeting",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-cancelled", callSid: call.providerCallId },
          }),
        );
        const callbacks = await bridgeCreated.promise;
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks.onReady?.();
        callbacks.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-partial" });

        callbacks.onResponseDone?.({
          status: "cancelled",
          responseId: "greeting",
          reason: "caller interruption",
        });

        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("realtime response cancelled: caller interruption"),
        );
        vi.advanceTimersByTime(1_000);
        expect(findGreetingCompletionMark(outboundFrames)).toBeUndefined();
        await expectCallerAudio(ws, providerAudio, "audio");
      } finally {
        vi.useRealTimers();
        log.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps protection until the carrier confirms the greeting played, then resumes caller audio",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-confirm", callSid: call.providerCallId },
          }),
        );
        const callbacks = await bridgeCreated.promise;
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks.onReady?.();
        // The provider produces the greeting, then reports the turn complete.
        callbacks.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);

        // The completion mark is queued only once the pacer is drained and the line is quiet.
        await outboundFrames.waitForFrame(
          (frame) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-greeting-complete-") === true,
        );
        expect(findGreetingCompletionMark(outboundFrames)).toBeDefined();
        expect(
          outboundFrames.some(
            (frame) => frame.event === "mark" && frame.mark?.name?.startsWith("openclaw-playout-"),
          ),
        ).toBe(true);

        // Until the carrier acknowledges the mark, caller audio is still muted.
        await expectCallerAudio(ws, providerAudio, "silence");

        // The carrier reports the mark reached playout; protection disarms.
        const greetingCompletionMark = findGreetingCompletionMark(outboundFrames);
        expect(greetingCompletionMark).toBeDefined();
        ws.send(JSON.stringify({ event: "mark", mark: { name: greetingCompletionMark } }));
        await expectCallerAudio(ws, providerAudio, "audio");
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases greeting protection when provider continuity resets",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-continuity-reset", callSid: call.providerCallId },
          }),
        );
        const callbacks = await bridgeCreated.promise;
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks.onReady?.();
        callbacks.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);
        await outboundFrames.waitForFrame(
          (frame) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-greeting-complete-") === true,
        );
        expect(findGreetingCompletionMark(outboundFrames)).toBeDefined();
        await expectCallerAudio(ws, providerAudio, "silence");

        const clearCountBeforeReset = outboundFrames.filter(
          (frame) => frame.event === "clear",
        ).length;
        callbacks.onEvent?.({ direction: "client", type: "session.continuity.reset" });

        expect(log).toHaveBeenCalledWith(expect.stringContaining("reason=continuity-reset"));
        await outboundFrames.waitForFrame(
          (frame, frames) =>
            frame.event === "clear" &&
            frames.filter((candidate) => candidate.event === "clear").length >=
              clearCountBeforeReset + 1,
        );
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(
          clearCountBeforeReset + 1,
        );
        await expectCallerAudio(ws, providerAudio, "audio");

        const playoutMarksBefore = countPlayoutMarks(outboundFrames);
        callbacks.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "after-reset" });
        // The reset's second clear (from the cancelled talk turn) lands a beat after
        // the first. Wait for the after-reset audio to reach the carrier so the count
        // has settled before we snapshot it, instead of sampling mid-flush.
        await outboundFrames.waitForFrame(
          (frame, frames) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-playout-") === true &&
            countPlayoutMarks(frames) >= playoutMarksBefore + 1,
        );
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        callbacks.onClearAudio("barge-in");
        await outboundFrames.waitForFrame(
          (frame, frames) =>
            frame.event === "clear" &&
            frames.filter((candidate) => candidate.event === "clear").length >= clearCount + 1,
        );
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(
          clearCount + 1,
        );
      } finally {
        vi.useRealTimers();
        log.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps caller audio muted until a late greeting is carrier-confirmed",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const handleBargeIn = vi.fn();
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            handleBargeIn,
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-late", callSid: call.providerCallId },
          }),
        );
        const callbacks = await bridgeCreated.promise;
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks.onReady?.();
        await expectCallerAudio(ws, providerAudio, "silence");

        vi.advanceTimersByTime(3_100);
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        providerAudio.length = 0;
        const callerAudioReceived = providerAudio.armForCount(4);
        for (let index = 0; index < 4; index += 1) {
          sendCallerAudio(ws);
        }
        await callerAudioReceived;
        expect(providerAudio).toHaveLength(4);
        expect(providerAudio.every(isSilence)).toBe(true);
        expect(handleBargeIn).not.toHaveBeenCalled();
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(clearCount);

        const playoutMarksBefore = countPlayoutMarks(outboundFrames);
        callbacks.onAudio?.(Buffer.alloc(160 * 16, 0xff), { itemId: "greeting-late" });
        callbacks.onResponseDone?.({ status: "completed", responseId: "greeting" });
        // The pacer drains queued audio on real time; wait for its playout boundary
        // (one per LEAD_MS of audio) so the fake-clock poll below sees a drained
        // line and arms the completion mark.
        await outboundFrames.waitForFrame(
          (frame, frames) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-playout-") === true &&
            countPlayoutMarks(frames) >= playoutMarksBefore + 2,
        );
        vi.advanceTimersByTime(1_000);
        await outboundFrames.waitForFrame(
          (frame) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-greeting-complete-") === true,
        );
        expect(findGreetingCompletionMark(outboundFrames)).toBeDefined();
        await expectCallerAudio(ws, providerAudio, "silence");

        const greetingCompletionMark = findGreetingCompletionMark(outboundFrames);
        expect(greetingCompletionMark).toBeDefined();
        ws.send(JSON.stringify({ event: "mark", mark: { name: greetingCompletionMark } }));
        await expectCallerAudio(ws, providerAudio, "audio");
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the greeting protected while its completion mark is unacknowledged",
    async () => {
      const bridgeCreated = createDeferred<RealtimeVoiceBridgeCreateRequest>();
      const providerAudio = observeProviderAudio();
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          bridgeCreated.resolve(request);
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
              providerAudio.notify();
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { ws } = await connectCarrierStream(handler);
      const outboundFrames = observeCarrierFrames(ws);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-unacknowledged", callSid: call.providerCallId },
          }),
        );
        const callbacks = await bridgeCreated.promise;
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        callbacks.onReady?.();
        callbacks.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks.onResponseDone?.({ status: "completed", responseId: "greeting" });
        vi.advanceTimersByTime(1_000);
        await outboundFrames.waitForFrame(
          (frame) =>
            frame.event === "mark" &&
            frame.mark?.name?.startsWith("openclaw-greeting-complete-") === true,
        );
        expect(findGreetingCompletionMark(outboundFrames)).toBeDefined();

        // Advancing beyond the former short grace must not substitute for carrier acknowledgement.
        vi.advanceTimersByTime(5_100);
        const clearCount = outboundFrames.filter((frame) => frame.event === "clear").length;
        callbacks.onClearAudio("barge-in");
        await expectCallerAudio(ws, providerAudio, "silence");
        expect(outboundFrames.filter((frame) => frame.event === "clear")).toHaveLength(clearCount);
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
