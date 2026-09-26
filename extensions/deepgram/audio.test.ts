import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const providers: MediaUnderstandingProvider[] = [];
plugin.register(
  createTestPluginApi({
    registerMediaUnderstandingProvider: (provider) => providers.push(provider),
  }),
);
const transcribeDeepgramAudio = providers.find(
  (provider) => provider.id === "deepgram",
)?.transcribeAudio;
if (!transcribeDeepgramAudio) {
  throw new Error("Deepgram audio transcription was not registered");
}

installPinnedHostnameTestHooks();

describe("transcribeDeepgramAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
    });

    const result = await transcribeDeepgramAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Token override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Token override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "hello" }] }] },
    });

    const result = await transcribeDeepgramAudio({
      buffer: Buffer.from([0xaa, 0x00, 0x7f, 0x80, 0xff, 0xbb]).subarray(1, 5),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      query: {
        punctuate: false,
        smart_format: true,
      },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("nova-3");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe(
      "https://api.example.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=true",
    );
    if (!seenInit) {
      throw new Error("Expected Deepgram fetch request init");
    }
    expect(seenInit.method).toBe("POST");
    expect(seenInit.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit.headers);
    expect(headers.get("authorization")).toBe("Token test-key");
    expect(headers.get("x-custom")).toBe("1");
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(seenInit.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(seenInit.body as Uint8Array)).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  it.each([
    {
      name: "each channel in provider order",
      transcripts: [" Left track. ", " Right track. "],
      expected: "Left track.\n\nRight track.",
    },
    {
      name: "speech after a silent first channel",
      transcripts: ["", "Only second track."],
      expected: "Only second track.",
    },
    {
      name: "repeated text from distinct channels",
      transcripts: ["Repeated.", "Repeated."],
      expected: "Repeated.\n\nRepeated.",
    },
  ])("retains $name", async ({ transcripts, expected }) => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      results: {
        channels: transcripts.map((transcript) => ({
          alternatives: [{ transcript }, { transcript: "Unused hypothesis." }],
        })),
      },
    });
    const result = await transcribeDeepgramAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      query: { multichannel: true },
      fetchFn,
    });

    expect(result.text).toBe(expected);
  });

  it.each([
    { name: "omitted", channels: [{ alternatives: [{}] }] },
    {
      name: "silent across all channels",
      channels: [{ alternatives: [{ transcript: "" }] }, { alternatives: [{ transcript: "   " }] }],
    },
  ])("throws when transcripts are $name", async ({ channels }) => {
    const { fetchFn } = createRequestCaptureJsonFetch({ results: { channels } });

    await expect(
      transcribeDeepgramAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing transcript");
  });

  it("rejects non-object successful transcription JSON with a stable provider error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([])));

    await expect(
      transcribeDeepgramAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });

  it("rejects wrong nested transcript shapes with a stable provider error", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      results: { channels: { alternatives: [{ transcript: "hello" }] } },
    });

    await expect(
      transcribeDeepgramAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });

  it.each([
    { name: "first channel", transcripts: [123] },
    { name: "later channel", transcripts: ["First track.", 123] },
  ])("rejects non-string transcript values in the $name", async ({ transcripts }) => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      results: {
        channels: transcripts.map((transcript) => ({ alternatives: [{ transcript }] })),
      },
    });

    await expect(
      transcribeDeepgramAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });
});
