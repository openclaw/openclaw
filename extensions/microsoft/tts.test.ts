import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

const baseEdgeConfig = {
  voice: "en-US-MichelleNeural",
  lang: "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  saveSubtitles: false,
};

describe("Microsoft speech synthesis", () => {
  const provider = buildMicrosoftSpeechProvider();
  const request = (text: string): Parameters<typeof provider.synthesize>[0] => ({
    text,
    cfg: {},
    providerConfig: baseEdgeConfig,
    timeoutMs: 10000,
    target: "audio-file",
  });
  beforeEach(async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    return () => state.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function synthesize(
    ttsPromise: (text: string, filePath: string) => Promise<void>,
    text = "Hello",
  ) {
    vi.spyOn(EdgeTTS.prototype, "ttsPromise").mockImplementation(ttsPromise);
    return provider.synthesize(request(text));
  }

  it("uses the supported Microsoft synthesis endpoint and authentication parameter", async () => {
    // Intercept the dependency's CommonJS transport, including Bun's native ws shim.
    const webSocketModule: typeof import("ws") = createRequire(import.meta.url)("ws");
    let requestUrl: URL | undefined;
    const intercepted = new Error("synthesis handshake intercepted");
    vi.spyOn(webSocketModule, "WebSocket").mockImplementation(function (address) {
      requestUrl = new URL(String(address));
      throw intercepted;
    });

    await expect(provider.synthesize(request("Hello"))).rejects.toBe(intercepted);

    expect(requestUrl?.protocol).toBe("wss:");
    expect(requestUrl?.hostname).toBe("api.msedgeservices.com");
    expect(requestUrl?.pathname).toBe("/tts/cognitiveservices/websocket/v1");
    expect(requestUrl?.searchParams.has("Ocp-Apim-Subscription-Key")).toBe(true);
  });

  it("rejects blank text before calling Edge TTS", async () => {
    const ttsPromise = vi.fn(async (_text: string, filePath: string) => {
      writeFileSync(filePath, Buffer.from([0xff]));
    });

    await expect(synthesize(ttsPromise, " \n\t ")).rejects.toThrow(
      "Microsoft TTS text cannot be empty",
    );
    expect(ttsPromise).not.toHaveBeenCalled();
  });

  it("throws after one retry when the output file stays empty", async () => {
    const calls: string[] = [];

    const tts = async (text: string, filePath: string) => {
      calls.push(text);
      writeFileSync(filePath, "");
    };

    await expect(synthesize(tts)).rejects.toThrow("Edge TTS produced empty audio file after retry");
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("succeeds when the output file has content", async () => {
    let stagedPath = "";

    const tts = async (_text: string, filePath: string) => {
      stagedPath = filePath;
      writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    };

    await expect(synthesize(tts)).resolves.toMatchObject({
      audioBuffer: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      outputFormat: baseEdgeConfig.outputFormat,
      fileExtension: ".mp3",
    });
    expect(path.basename(stagedPath)).toContain("speech.mp3");
    expect(path.basename(stagedPath)).toMatch(/\.part$/);
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(path.dirname(stagedPath))).toBe(false);
  });

  it("retries once when Edge TTS resolves without creating an output file", async () => {
    const calls: string[] = [];

    const tts = async (text: string, filePath: string) => {
      calls.push(text);
      if (calls.length === 2) {
        writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      }
    };

    await expect(synthesize(tts)).resolves.toMatchObject({
      audioBuffer: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    });
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("does not retry provider errors", async () => {
    const calls: string[] = [];

    const tts = async (text: string) => {
      calls.push(text);
      throw new Error("upstream timeout");
    };

    await expect(synthesize(tts)).rejects.toThrow("upstream timeout");
    expect(calls).toEqual(["Hello"]);
  });

  it("falls back to the default format when the configured format fails", async () => {
    const stagedPaths: string[] = [];
    vi.spyOn(EdgeTTS.prototype, "ttsPromise").mockImplementation(async (_text, filePath) => {
      stagedPaths.push(filePath);
      if (stagedPaths.length === 1) {
        throw new Error("unsupported output format");
      }
      writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await expect(
      provider.synthesize({
        ...request("Hello"),
        providerConfig: { ...baseEdgeConfig, outputFormat: "ogg-24khz-16bit-mono-opus" },
      }),
    ).resolves.toMatchObject({
      audioBuffer: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      outputFormat: baseEdgeConfig.outputFormat,
      fileExtension: ".mp3",
    });
    expect(stagedPaths).toEqual([
      expect.stringMatching(/speech[.]ogg.*[.]part$/),
      expect.stringMatching(/speech[.]mp3.*[.]part$/),
    ]);
    for (const filePath of stagedPaths) {
      expect(existsSync(filePath)).toBe(false);
    }
  });
});
