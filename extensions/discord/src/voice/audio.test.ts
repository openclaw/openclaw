import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { decodeOpusStream, decodeOpusStreamChunks, resolveOpusDecoderPreference } from "./audio.js";

describe("discord voice opus decoder selection", () => {
  it("defaults to the safe WASM opus decoder", async () => {
    const verbose: string[] = [];
    const warnings: string[] = [];
    const previousPreference = process.env.OPENCLAW_DISCORD_OPUS_DECODER;
    delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;

    try {
      const decoded = await decodeOpusStream(Readable.from([]), {
        onVerbose: (message) => verbose.push(message),
        onWarn: (message) => warnings.push(message),
      });

      expect(decoded.length).toBe(0);
      expect(verbose).toContain("opus decoder: opus-decoder");
      expect(warnings).toEqual([]);
    } finally {
      if (previousPreference === undefined) {
        delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;
      } else {
        process.env.OPENCLAW_DISCORD_OPUS_DECODER = previousPreference;
      }
    }
  });

  it("requires an explicit preference for native opus", () => {
    const previousPreference = process.env.OPENCLAW_DISCORD_OPUS_DECODER;
    delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;

    try {
      expect(resolveOpusDecoderPreference()).toBe("wasm");
      expect(resolveOpusDecoderPreference("opusscript")).toBe("opusscript");
      expect(resolveOpusDecoderPreference("native")).toBe("native");
      expect(resolveOpusDecoderPreference("@discordjs/opus")).toBe("native");
    } finally {
      if (previousPreference === undefined) {
        delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;
      } else {
        process.env.OPENCLAW_DISCORD_OPUS_DECODER = previousPreference;
      }
    }
  });

  it("surfaces chunk decode stream failures to callers", async () => {
    const err = new Error("memory access out of bounds");
    const onError = vi.fn();
    const stream = new Readable({
      read() {
        this.destroy(err);
      },
    });

    await decodeOpusStreamChunks(stream, {
      onChunk: vi.fn(),
      onError,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith(err);
  });
});
