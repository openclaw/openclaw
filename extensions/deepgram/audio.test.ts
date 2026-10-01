import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
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

const audioRequest = {
  buffer: Buffer.from("audio-bytes"),
  fileName: "voice.wav",
  apiKey: "test-key",
  timeoutMs: 1234,
};

describe("transcribeDeepgramAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
    });
    const result = await transcribeDeepgramAudio({
      ...audioRequest,
      headers: { authorization: "Token override" },
      fetchFn,
    });

    expect(new Headers(getRequest().init?.headers).get("authorization")).toBe("Token override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "hello" }] }] },
    });

    const result = await transcribeDeepgramAudio({
      ...audioRequest,
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
      ...audioRequest,
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
        ...audioRequest,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing transcript");
  });

  it.each([
    {
      name: "wrong nested transcript shapes",
      channels: { alternatives: [{ transcript: "hello" }] },
    },
    {
      name: "non-string transcript values in a later channel",
      channels: ["First track.", 123].map((transcript) => ({ alternatives: [{ transcript }] })),
    },
  ])("rejects $name with a stable provider error", async ({ channels }) => {
    const { fetchFn } = createRequestCaptureJsonFetch({ results: { channels } });
    await expect(
      transcribeDeepgramAudio({
        ...audioRequest,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription failed: malformed JSON response");
  });
});
