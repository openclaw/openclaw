import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { expectDefined } from "@openclaw/normalization-core";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { expect, it } from "vitest";
import plugin from "./index.js";

const { api, mediaUnderstandingProviders: providers } = createCapturedPluginRegistration();
plugin.register(api);
const transcribeDeepgramAudio = expectDefined(
  providers.find((provider) => provider.id === "deepgram")?.transcribeAudio,
  "Deepgram audio transcription was not registered",
);
installPinnedHostnameTestHooks();

function makeChannels(transcripts: unknown[]) {
  return transcripts.map((transcript) => ({
    alternatives: [{ transcript }, { transcript: "Unused hypothesis." }],
  }));
}

function capture(responseChannels: unknown = makeChannels(["hello"])) {
  const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
    results: { channels: responseChannels },
  });
  return {
    getRequest,
    run: (options: Partial<AudioTranscriptionRequest> = {}) =>
      transcribeDeepgramAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
        ...options,
      }),
  };
}

it.each([undefined, "Token override"])(
  "builds the request with authorization override %s",
  async (authorization) => {
    const { run, getRequest } = capture();
    const result = await run({
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      mime: "audio/wav",
      headers: { "X-Custom": "1", ...(authorization ? { authorization } : {}) },
      query: { punctuate: false, smart_format: true },
    });
    const { url: seenUrl, init } = getRequest();
    const seenInit = expectDefined(init, "Expected Deepgram fetch request init");
    expect(result).toMatchObject({ model: "nova-3", text: "hello" });
    expect(seenUrl).toBe(
      "https://api.example.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=true",
    );
    expect(seenInit).toMatchObject({
      method: "POST",
      signal: expect.any(AbortSignal),
      body: expect.any(Uint8Array),
    });
    expect(Object.fromEntries(new Headers(seenInit.headers))).toMatchObject({
      authorization: authorization ?? "Token test-key",
      "x-custom": "1",
      "content-type": "audio/wav",
    });
  },
);

it.each([[["OpenClaw", "Deepgram"]], [[]]])("encodes keyterms %j", async (keyterm) => {
  const { run, getRequest } = capture();
  await run({ query: { keyterm } });
  const url = new URL(expectDefined(getRequest().url, "Deepgram request URL"));
  expect(url.searchParams.getAll("keyterm")).toEqual(keyterm);
});

it.each([
  ["provider order", [" Left track. ", " Right track. "], "Left track.\n\nRight track."],
  ["speech after a silent first channel", ["", "Only second track."], "Only second track."],
  ["an empty transcript when every channel is silent", ["", "   "], ""],
  ["repeated text from distinct channels", ["Repeated.", "Repeated."], "Repeated.\n\nRepeated."],
] satisfies [string, string[], string][])("retains %s", async (_name, transcripts, expected) => {
  const result = await capture(makeChannels(transcripts)).run({ query: { multichannel: true } });
  expect(result.text).toBe(expected);
});

const missing = "Audio transcription response missing transcript";
const malformed = "Audio transcription failed: malformed JSON response";
it.each([
  ["missing only transcript", makeChannels([undefined]), missing],
  ["missing transcript before silence", makeChannels([undefined, ""]), missing],
  ["missing transcript after silence", makeChannels([" \t", undefined]), missing],
  ["missing transcript after speech", makeChannels(["hello", undefined]), missing],
  ["wrong nested shape", { alternatives: [{ transcript: "hello" }] }, malformed],
  ["non-string transcript after speech", makeChannels(["First track.", 123]), malformed],
  ["non-string transcript before silence", makeChannels([null, ""]), malformed],
] satisfies [string, unknown, string][])("rejects %s", async (_name, channels, error) => {
  await expect(capture(channels).run()).rejects.toThrow(error);
});
