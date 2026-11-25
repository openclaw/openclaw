import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

const audioBuffer = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const expectedAudio = {
  audioBuffer,
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  fileExtension: ".mp3",
};
const writeAudio = async (_text: string, filePath: string) => {
  writeFileSync(filePath, audioBuffer);
};
describe("Microsoft speech synthesis", () => {
  const provider = buildMicrosoftSpeechProvider();
  const request = (
    text = "Hello",
    outputFormat = expectedAudio.outputFormat,
  ): Parameters<typeof provider.synthesize>[0] => ({
    text,
    cfg: {},
    providerConfig: { outputFormat },
    timeoutMs: 10000,
    target: "audio-file",
  });
  beforeEach(async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    return () => state.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());
  function synthesize(ttsPromise: typeof EdgeTTS.prototype.ttsPromise, text = "Hello") {
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
    expect(`${requestUrl?.origin}${requestUrl?.pathname}`).toBe(
      "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1",
    );
    expect(requestUrl?.searchParams.has("Ocp-Apim-Subscription-Key")).toBe(true);
  });

  it("rejects blank text before calling Edge TTS", async () => {
    const tts = vi.fn<typeof EdgeTTS.prototype.ttsPromise>();
    await expect(synthesize(tts, " \n\t ")).rejects.toThrow("Microsoft TTS text cannot be empty");
    expect(tts).not.toHaveBeenCalled();
  });

  it("throws after one retry when the output file stays empty", async () => {
    const tts = vi.fn(async (_text: string, filePath: string) => {
      writeFileSync(filePath, "");
    });
    await expect(synthesize(tts)).rejects.toThrow("Edge TTS produced empty audio file after retry");
    expect(tts.mock.calls.map(([text]) => text)).toEqual(["Hello", "Hello"]);
  });

  it("succeeds when the output file has content", async () => {
    const tts = vi.fn(writeAudio);
    await expect(synthesize(tts)).resolves.toMatchObject(expectedAudio);
    const firstCall = tts.mock.calls[0];
    assert(firstCall);
    const stagedPath = firstCall[1];
    expect(path.basename(stagedPath)).toMatch(/speech[.]mp3.*[.]part$/);
    expect([stagedPath, path.dirname(stagedPath)].filter(existsSync)).toEqual([]);
  });

  it("retries once when Edge TTS resolves without creating an output file", async () => {
    const tts = vi.fn(writeAudio).mockResolvedValueOnce(undefined);
    await expect(synthesize(tts)).resolves.toMatchObject({ audioBuffer });
    expect(tts.mock.calls.map(([text]) => text)).toEqual(["Hello", "Hello"]);
  });

  it("does not retry provider errors", async () => {
    const tts = vi
      .fn<typeof EdgeTTS.prototype.ttsPromise>()
      .mockRejectedValue(new Error("upstream timeout"));
    await expect(synthesize(tts)).rejects.toThrow("upstream timeout");
    expect(tts.mock.calls).toEqual([["Hello", expect.any(String)]]);
  });

  it("falls back to the default format when the configured format fails", async () => {
    const tts = vi
      .spyOn(EdgeTTS.prototype, "ttsPromise")
      .mockRejectedValueOnce(new Error("unsupported output format"))
      .mockImplementation(writeAudio);
    await expect(
      provider.synthesize(request("Hello", "ogg-24khz-16bit-mono-opus")),
    ).resolves.toMatchObject(expectedAudio);
    const stagedPaths = tts.mock.calls.map(([, filePath]) => filePath);
    expect(stagedPaths).toEqual([
      expect.stringMatching(/speech[.]ogg.*[.]part$/),
      expect.stringMatching(/speech[.]mp3.*[.]part$/),
    ]);
    expect(stagedPaths.filter(existsSync)).toEqual([]);
  });
});
