import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";

const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * 250;

function readPendingAudio(pending: OpenAIQuicksilverPendingAudio): Buffer {
  const audio = Buffer.alloc(pending.length);
  expect(pending.readInto(audio)).toBe(audio.length);
  return audio;
}

describe("GPT-Live pending microphone audio", () => {
  let pending: OpenAIQuicksilverPendingAudio;
  beforeEach(() => {
    pending = new OpenAIQuicksilverPendingAudio();
  });
  afterEach(() => vi.restoreAllMocks());
  it("copies caller-owned PCM16 and drops an incomplete sample", () => {
    const source = Buffer.from([0x01, 0x02, 0x03]);
    pending.append(source);
    source.fill(0xff);

    expect(readPendingAudio(pending)).toEqual(Buffer.from([0x01, 0x02]));
  });

  it("retains the newest bounded tail across existing and oversized input", () => {
    pending.append(Buffer.alloc(MAX_PENDING_AUDIO_BYTES, 0x01));
    pending.append(Buffer.from([0x02, 0x02]));
    const appended = readPendingAudio(pending);
    const oversized = Buffer.alloc(MAX_PENDING_AUDIO_BYTES + 4, 0x03);
    oversized.writeUInt16LE(0x1111, 0);
    oversized.writeUInt16LE(0x2222, oversized.length - 2);
    const expectedOversizedTail = Buffer.from(oversized.subarray(4));
    pending.append(oversized);
    oversized.fill(0xff);

    expect(appended).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(appended.subarray(0, -2).every((byte) => byte === 0x01)).toBe(true);
    expect(appended.subarray(-2)).toEqual(Buffer.from([0x02, 0x02]));
    expect(readPendingAudio(pending)).toEqual(expectedOversizedTail);
  });

  it("reads ordered PCM across both sides of the circular storage", () => {
    pending.append(Buffer.alloc(MAX_PENDING_AUDIO_BYTES - 4, 0x01));
    pending.readInto(Buffer.alloc(MAX_PENDING_AUDIO_BYTES - 6));
    pending.append(Buffer.from([0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]));
    const wrappedRead = Buffer.alloc(8);

    expect(pending.readInto(wrappedRead)).toBe(8);
    expect(wrappedRead).toEqual(Buffer.from([0x01, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
    expect(readPendingAudio(pending)).toEqual(Buffer.from([0x08, 0x09]));
    expect(pending).toHaveLength(0);
  });

  it("never splits a PCM16 sample when the read target has an odd length", () => {
    pending.append(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const target = Buffer.alloc(3, 0xff);

    expect(pending.readInto(target)).toBe(2);
    expect(target).toEqual(Buffer.from([0x01, 0x02, 0xff]));
    expect(readPendingAudio(pending)).toEqual(Buffer.from([0x03, 0x04]));
  });

  it("releases circular storage on clear without allocating an output copy", () => {
    const sample = Buffer.from([0x01, 0x02]);
    const allocations = vi.spyOn(Buffer, "alloc");
    pending.append(sample);
    pending.clear();
    pending.append(sample);
    const allocatedSizes = allocations.mock.calls.map(([bytes]) => bytes);
    allocations.mockRestore();
    expect(allocatedSizes).toEqual([MAX_PENDING_AUDIO_BYTES, MAX_PENDING_AUDIO_BYTES]);
    expect(readPendingAudio(pending)).toEqual(sample);
  });

  it("copies each of 500 capture frames once without concatenating retained history", () => {
    const frame = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    const copy = vi.spyOn(Buffer.prototype, "copy");
    const concat = vi.spyOn(Buffer, "concat");
    const allocations = vi.spyOn(Buffer, "alloc");
    for (let index = 0; index < 500; index += 1) {
      frame.fill(index & 0xff);
      pending.append(frame);
    }
    const copiedBytes = copy.mock.results.reduce(
      (sum, { value }) => sum + (typeof value === "number" ? value : 0),
      0,
    );
    const concatCalls = concat.mock.calls.length;
    const allocatedSizes = allocations.mock.calls.map(([bytes]) => bytes);
    vi.restoreAllMocks();
    expect(copiedBytes).toBe(500 * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    expect(concatCalls).toBe(0);
    expect(allocatedSizes).toEqual([MAX_PENDING_AUDIO_BYTES]);
    const retained = readPendingAudio(pending);
    expect(retained).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(retained[0]).toBe(250);
    expect(retained.at(-1)).toBe(499 & 0xff);
  });

  it("clears pending PCM without exposing stale samples", () => {
    pending.append(Buffer.from([0x01, 0x02]));
    pending.clear();
    const target = Buffer.alloc(2, 0xff);

    expect(pending).toHaveLength(0);
    expect(pending.readInto(target)).toBe(0);
    expect(target).toEqual(Buffer.from([0xff, 0xff]));
  });
});
