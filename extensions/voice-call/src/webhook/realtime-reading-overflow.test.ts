import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  type RealtimeVoiceBridgeCallbacks,
  buildRealtimeVoiceSpeakExactMessage,
  createRealtimeVoiceBridgeSession,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { makeBridge, makeRealtimeProvider } from "./realtime-call-control.test-helpers.js";
import { attachRealtimeReading } from "./realtime-reading.js";
import { StreamFrameAdapter } from "./stream-frame-adapter.js";

// Synthetic model/carrier replay, not evidence of a live model or audible call.
// Each character has one uniquely numbered 20 ms frame: 9,000 characters = 180 s.
const TEXT = "word ".repeat(1_800);
const AUDIO = Buffer.alloc(TEXT.length * 160);
for (let frame = 0; frame < TEXT.length; frame += 1) {
  AUDIO.fill(frame % 256, frame * 160, (frame + 1) * 160);
  AUDIO.writeUInt32LE(frame, frame * 160);
}

afterEach(() => vi.useRealTimers());

describe("long reading playback overflow replay", () => {
  it.each([false, true])(
    "replays 180 seconds at 4x generation speed (sequenced=%s)",
    async (sequenced) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const prompts: string[] = [];
      const sentAudio: Buffer[] = [];
      const playedMarks: string[] = [];
      const pendingAcks = new Map<string, () => void>();
      let carrierEndsAt = Date.now();
      const startedAt = Date.now();
      let overflowAt: number | undefined;
      const adapter = new StreamFrameAdapter("twilio");
      const pacer = new RealtimeAudioPacer({
        serializer: adapter,
        onBackpressure: () => {
          overflowAt = Date.now() - startedAt;
        },
        send: (message) => {
          const frame = adapter.parseInbound(message);
          if (frame.kind === "media") {
            const audio = Buffer.from(frame.payloadBase64, "base64");
            sentAudio.push(audio);
            carrierEndsAt = Math.max(carrierEndsAt, Date.now()) + audio.length / 8;
          } else if (frame.kind === "mark" && frame.name) {
            // The carrier reports a mark only after all preceding audio plays.
            const name = frame.name;
            setTimeout(() => playedMarks.push(name), Math.max(0, carrierEndsAt - Date.now()));
          }
          return true;
        },
      });
      let reading: ReturnType<typeof attachRealtimeReading> = undefined;
      let modelCallbacks: RealtimeVoiceBridgeCallbacks | undefined;
      const session = createRealtimeVoiceBridgeSession({
        provider: makeRealtimeProvider((callbacks) => {
          modelCallbacks = callbacks;
          return makeBridge({
            outputAudioMode: "response",
            triggerGreeting: (prompt) => prompts.push(prompt ?? ""),
          });
        }),
        onResponseDone: (outcome) => reading?.responseDone(outcome),
        providerConfig: {},
        audioSink: { sendAudio: (audio, metadata) => pacer.sendAudio(audio, metadata) },
      });
      const opening = buildRealtimeVoiceSpeakExactMessage({
        text: TEXT,
        surfaceLabel: "the callee",
      });
      reading = sequenced
        ? attachRealtimeReading({
            session,
            text: TEXT,
            instructions: "Read the supplied text.",
            initialGreetingInstructions: opening,
            handlesAgentConsult: false,
            afterPlayback: (mark, acknowledge) => {
              pendingAcks.set(mark, acknowledge);
              pacer.sendMark(mark);
            },
          })
        : undefined;
      session.triggerGreeting(opening);
      let generatedCharacters = 0;
      let passageCount = 0;
      try {
        while (generatedCharacters < TEXT.length) {
          if (overflowAt !== undefined) {
            break;
          }
          const prompt = expectDefined(prompts[passageCount], "next passage request");
          const passage = JSON.parse(prompt.slice(prompt.lastIndexOf("Answer: ") + 8)) as string;
          expect(passage).toBe(
            TEXT.slice(generatedCharacters, generatedCharacters + passage.length),
          );
          const end = generatedCharacters + passage.length;
          // One-second chunks every 250 ms keep the queue occupied at 4x playback.
          while (generatedCharacters < end) {
            if (overflowAt !== undefined) {
              break;
            }
            const chunkEnd = Math.min(end, generatedCharacters + 50);
            expectDefined(modelCallbacks, "model callbacks").onAudio(
              AUDIO.subarray(generatedCharacters * 160, chunkEnd * 160),
            );
            generatedCharacters = chunkEnd;
            await vi.advanceTimersByTimeAsync(250);
          }
          passageCount += 1;
          modelCallbacks?.onResponseDone?.({ status: "completed" });
          if (sequenced) {
            await vi.advanceTimersByTimeAsync(passage.length * 20);
            expect(playedMarks).toHaveLength(passageCount);
            // Even a drained queue does not authorize the next generation until ack delivery.
            expect(prompts).toHaveLength(passageCount);
            await vi.advanceTimersByTimeAsync(500);
            expect(prompts).toHaveLength(passageCount);
            const mark = expectDefined(playedMarks[passageCount - 1], "played passage mark");
            pacer.acknowledgeMark(mark);
            pendingAcks.get(mark)?.();
            pendingAcks.delete(mark);
          }
        }
        const delivered = Buffer.concat(sentAudio);
        if (sequenced) {
          expect(overflowAt).toBeUndefined();
          expect(delivered.equals(AUDIO)).toBe(true);
          expect(delivered.length).toBe(1_440_000);
          expect(passageCount).toBeGreaterThan(1);
          expect(prompts).toHaveLength(passageCount);
          expect(pendingAcks.size).toBe(0);
          expect(pacer.hasPendingAudio()).toBe(false);
        } else {
          expect(overflowAt).toBeGreaterThanOrEqual(39_000);
          expect(overflowAt).toBeLessThan(41_000);
          expect(delivered.length).toBeLessThan(8_000 * 41);
          expect(generatedCharacters * 160 - delivered.length).toBeGreaterThan(8_000 * 119);
          expect(pacer.hasPendingAudio()).toBe(false);
        }
      } finally {
        reading?.cancel();
        pacer.close();
        await session.close();
      }
    },
  );
});
