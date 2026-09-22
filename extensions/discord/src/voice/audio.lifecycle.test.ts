import { once } from "node:events";
import { Readable } from "node:stream";
import type { OpusEncoderHandle } from "libopus-wasm";
import { beforeEach, expect, it, vi } from "vitest";

const { createEncoderMock, createDecoderMock } = vi.hoisted(() => ({
  createEncoderMock: vi.fn(),
  createDecoderMock: vi.fn(),
}));
vi.mock("libopus-wasm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("libopus-wasm")>()),
  createEncoder: createEncoderMock,
  createDecoder: createDecoderMock,
}));

import { createDiscordOpusEncodeStream, decodeOpusStreamChunks } from "./audio.js";

beforeEach(() => {
  createEncoderMock.mockReset();
  createDecoderMock.mockReset();
});

it.each([false, true])(
  "preserves PCM frames across arbitrary splits and caller reuse (partial flush: %s)",
  async (flushBetween) => {
    const frameBytes = 960 * 2 * 2;
    const pcm = Buffer.alloc(frameBytes * 5 + 336);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = (index * 37 + 11) % 251;
    }
    const parts = [pcm.subarray(0, frameBytes * 4 + 317), pcm.subarray(frameBytes * 4 + 317)];
    const codec = await vi.importActual<typeof import("libopus-wasm")>("libopus-wasm");
    const encoder = await codec.createEncoder({
      application: codec.Application.Audio,
      channels: 2,
      sampleRate: 48_000,
    });
    const encode = encoder.encode.bind(encoder);
    const frames: Buffer[] = [];
    vi.spyOn(encoder, "encode").mockImplementation((input, options) => {
      frames.push(Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)));
      return encode(input, options);
    });
    createEncoderMock.mockResolvedValueOnce(encoder);
    const stream = createDiscordOpusEncodeStream();
    const consumedBytes: number[] = [];
    const consume = async () => {
      for await (const packet of stream) {
        consumedBytes.push(stream.takePcmBytes(packet));
      }
    };
    const write = async () => {
      for (const [partIndex, part] of parts.entries()) {
        let offset = 0;
        for (const size of [1, frameBytes - 2, 1, frameBytes + 1, part.length]) {
          if (offset >= part.length) {
            break;
          }
          const chunk = Buffer.from(part.subarray(offset, offset + size));
          offset += chunk.length;
          await new Promise<void>((resolve, reject) => {
            stream.write(chunk, (error) => {
              chunk.fill(0x7f);
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
        if (flushBetween && partIndex === 0) {
          expect(stream.flushPartialFrame()).toBe(true);
          expect(stream.flushPartialFrame()).toBe(false);
        }
      }
      stream.end();
    };
    try {
      await Promise.all([consume(), write()]);
      const expectedFrames: Buffer[] = [];
      const expectedBytes: number[] = [];
      for (const part of flushBetween ? parts : [pcm]) {
        for (let offset = 0; offset < part.length; offset += frameBytes) {
          const frame = Buffer.alloc(frameBytes);
          expectedBytes.push(part.copy(frame, 0, offset, offset + frameBytes));
          expectedFrames.push(frame);
        }
      }
      expect(frames).toEqual(expectedFrames);
      expect(consumedBytes).toEqual(expectedBytes);
    } finally {
      stream.destroy();
      encoder.free();
      vi.restoreAllMocks();
    }
  },
);

it("releases an encoder acquired after playback was destroyed without encoding queued audio", async () => {
  const codec = await vi.importActual<typeof import("libopus-wasm")>("libopus-wasm");
  const encoder = await codec.createEncoder({ channels: 2, sampleRate: 48_000 });
  const encode = vi.spyOn(encoder, "encode");
  const free = vi.spyOn(encoder, "free");
  let resolveEncoder!: (encoder: OpusEncoderHandle) => void;
  createEncoderMock.mockReturnValueOnce(
    new Promise<OpusEncoderHandle>((resolve) => {
      resolveEncoder = resolve;
    }),
  );
  const stream = createDiscordOpusEncodeStream();
  try {
    stream.write(Buffer.alloc(960 * 2 * 2));
    await vi.waitFor(() => expect(createEncoderMock).toHaveBeenCalledOnce());
    const closed = once(stream, "close");
    stream.destroy();
    resolveEncoder(encoder);
    await closed;

    expect(free).toHaveBeenCalledOnce();
    expect(encode).not.toHaveBeenCalled();
  } finally {
    stream.destroy();
    encoder.free();
    vi.restoreAllMocks();
  }
});

it("reports encoder initialization failures without producing queued audio", async () => {
  const error = new Error("encoder initialization failed");
  createEncoderMock.mockRejectedValueOnce(error);
  const stream = createDiscordOpusEncodeStream();
  const errors: Error[] = [];
  stream.on("error", (err) => errors.push(err));
  const closed = new Promise<void>((resolve) => {
    stream.once("close", resolve);
  });
  stream.end(Buffer.alloc(960 * 2 * 2));
  await closed;

  expect(errors).toEqual([error]);
  expect(stream.read()).toBeNull();
});

it("yields between encoding batches and pauses until the player consumes packets", async () => {
  const codec = await vi.importActual<typeof import("libopus-wasm")>("libopus-wasm");
  const encoder = await codec.createEncoder({ channels: 2, sampleRate: 48_000 });
  const encode = encoder.encode.bind(encoder);
  let encodedPackets = 0;
  let observeFirstYield!: (packets: number) => void;
  const firstYield = new Promise<number>((resolve) => {
    observeFirstYield = resolve;
  });
  vi.spyOn(encoder, "encode").mockImplementation((input, options) => {
    encodedPackets += 1;
    if (encodedPackets === 1) {
      setImmediate(() => observeFirstYield(encodedPackets));
    }
    return encode(input, options);
  });
  createEncoderMock.mockResolvedValueOnce(encoder);
  const stream = createDiscordOpusEncodeStream();
  const packetCount = 128;
  const pcmBytes = packetCount * 960 * 2 * 2;
  try {
    stream.end(Buffer.alloc(pcmBytes));
    expect(await firstYield).toBeLessThan(packetCount);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stream.readableLength).toBeLessThanOrEqual(stream.readableHighWaterMark);
    expect(encodedPackets).toBeLessThanOrEqual(stream.readableHighWaterMark);

    let receivedBytes = 0;
    let receivedPackets = 0;
    for await (const packet of stream) {
      receivedBytes += stream.takePcmBytes(packet);
      receivedPackets += 1;
    }
    expect(receivedPackets).toBe(packetCount);
    expect(receivedBytes).toBe(pcmBytes);
  } finally {
    stream.destroy();
    encoder.free();
    vi.restoreAllMocks();
  }
});

it("cancels yielded encoding and settles the pending write without emitting remaining packets", async () => {
  const codec = await vi.importActual<typeof import("libopus-wasm")>("libopus-wasm");
  const encoder = await codec.createEncoder({ channels: 2, sampleRate: 48_000 });
  const encode = vi.spyOn(encoder, "encode");
  const free = vi.spyOn(encoder, "free");
  createEncoderMock.mockResolvedValueOnce(encoder);
  const stream = createDiscordOpusEncodeStream();
  const readable = once(stream, "readable");
  const writeDone = new Promise<Error | null | undefined>((resolve) => {
    stream.write(Buffer.alloc(128 * 960 * 2 * 2), resolve);
  });
  try {
    await readable;
    const encodedBeforeCancel = encode.mock.calls.length;
    expect(encodedBeforeCancel).toBeLessThan(128);
    const closed = once(stream, "close");
    stream.destroy();
    await closed;
    await expect(writeDone).resolves.toBeInstanceOf(Error);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(encode).toHaveBeenCalledTimes(encodedBeforeCancel);
    expect(free).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
    encoder.free();
    vi.restoreAllMocks();
  }
});

it("reports decoder initialization failure to the receive owner", async () => {
  const error = new Error("decoder initialization failed");
  createDecoderMock.mockRejectedValueOnce(error);
  const onError = vi.fn();
  const onChunk = vi.fn();
  await decodeOpusStreamChunks(Readable.from([Buffer.from([0xf8, 0xff, 0xfe])]), {
    onError,
    onChunk,
    onVerbose: vi.fn(),
    onWarn: vi.fn(),
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(onChunk).not.toHaveBeenCalled();
});
