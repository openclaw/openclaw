import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { expectDefined } from "@openclaw/normalization-core";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const { api, mediaUnderstandingProviders: providers } = createCapturedPluginRegistration();
plugin.register(api);
const transcribeDeepgramAudio = expectDefined(
  providers.find((provider) => provider.id === "deepgram")?.transcribeAudio,
  "Deepgram audio transcription was not registered",
);

installPinnedHostnameTestHooks();

const audioRequest = {
  buffer: Buffer.from("audio-bytes"),
  fileName: "voice.wav",
  apiKey: "test-key",
  timeoutMs: 1234,
};

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
      transcribeDeepgramAudio({ ...audioRequest, fetchFn, ...options }),
  };
}

describe("transcribeDeepgramAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { run, getRequest } = capture(makeChannels(["ok"]));
    const result = await run({ headers: { authorization: "Token override" } });
    expect(new Headers(getRequest().init?.headers).get("authorization")).toBe("Token override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { run, getRequest } = capture();
    const result = await run({
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      query: { punctuate: false, smart_format: true },
    });
    const { url: seenUrl, init } = getRequest();
    const seenInit = expectDefined(init, "Expected Deepgram fetch request init");

    expect(result).toMatchObject({ model: "nova-3", text: "hello" });
    expect(seenUrl).toBe(
      "https://api.example.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=true",
    );
    expect(seenInit.method).toBe("POST");
    expect(seenInit.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit.headers);
    expect(headers.get("authorization")).toBe("Token test-key");
    expect(headers.get("x-custom")).toBe("1");
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(seenInit.body).toBeInstanceOf(Uint8Array);
  });

  it.each([{ keyterm: ["OpenClaw", "Deepgram"] }, { keyterm: [] }])(
    "sends array query values as repeated parameters: $keyterm",
    async ({ keyterm }) => {
      const { run, getRequest } = capture();
      await run({ query: { keyterm } });
      expect(
        new URL(expectDefined(getRequest().url, "Deepgram request URL")).searchParams.getAll(
          "keyterm",
        ),
      ).toEqual(keyterm);
    },
  );

  it.each([
    [
      "each channel in provider order",
      [" Left track. ", " Right track. "],
      "Left track.\n\nRight track.",
    ],
    ["speech after a silent first channel", ["", "Only second track."], "Only second track."],
    ["an empty transcript when every channel is silent", ["", "   "], ""],
    ["repeated text from distinct channels", ["Repeated.", "Repeated."], "Repeated.\n\nRepeated."],
  ] satisfies [string, string[], string][])("retains %s", async (_name, transcripts, expected) => {
    const result = await capture(makeChannels(transcripts)).run({ query: { multichannel: true } });
    expect(result.text).toBe(expected);
  });

  it.each([
    { name: "the only channel", transcripts: [undefined] },
    { name: "the first channel before silence", transcripts: [undefined, ""] },
    { name: "a later channel after silence", transcripts: [" \t", undefined] },
    { name: "a later channel after speech", transcripts: ["hello", undefined] },
  ])("rejects a missing transcript in $name", async ({ transcripts }) => {
    await expect(capture(makeChannels(transcripts)).run()).rejects.toThrow(
      "Audio transcription response missing transcript",
    );
  });

  it.each([
    ["wrong nested transcript shapes", { alternatives: [{ transcript: "hello" }] }],
    ["non-string transcript values in a later channel", makeChannels(["First track.", 123])],
    ["a non-string transcript before a silent channel", makeChannels([null, ""])],
  ] satisfies [string, unknown][])(
    "rejects %s with a stable provider error",
    async (_name, value) => {
      await expect(capture(value).run()).rejects.toThrow(
        "Audio transcription failed: malformed JSON response",
      );
    },
  );
});
