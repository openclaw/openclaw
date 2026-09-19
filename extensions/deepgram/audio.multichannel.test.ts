import { expectDefined } from "@openclaw/normalization-core";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const providers: MediaUnderstandingProvider[] = [];
plugin.register(
  createTestPluginApi({
    registerMediaUnderstandingProvider: (provider) => providers.push(provider),
  }),
);
const transcribeAudio = expectDefined(
  providers.find((provider) => provider.id === "deepgram")?.transcribeAudio,
  "Deepgram must register its audio transcription callback",
);

function stereoWav(): Buffer {
  const wav = Buffer.alloc(108);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(64000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

async function requestTranscript(channels: unknown[]) {
  const audioInput = stereoWav();
  const requests: { url: string; method: string | undefined; audio: Buffer }[] = [];
  let text: string | undefined;
  let error: unknown;
  await withServer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", method: req.method, audio: Buffer.concat(chunks) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: { channels } }));
      });
    },
    async (baseUrl) => {
      try {
        const result = await transcribeAudio({
          buffer: audioInput,
          fileName: "two-channels.wav",
          mime: "audio/wav",
          apiKey: "synthetic-key",
          model: "nova-3",
          baseUrl: "https://api.deepgram.com/v1",
          query: { multichannel: true },
          fetchFn: (input, init) => {
            const requested = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            expect(requested.origin).toBe("https://api.deepgram.com");
            // The configured provider remains subject to its real public-host
            // policy; only the external network hop is mapped to this fixture.
            return fetch(new URL(`${requested.pathname}${requested.search}`, baseUrl), {
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
              signal: init?.signal,
            });
          },
          timeoutMs: 5000,
        });
        text = result.text;
        expect(result.model).toBe("nova-3");
      } catch (caught) {
        error = caught;
      }
    },
  );
  expect(requests, error instanceof Error ? error.message : String(error)).toHaveLength(1);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.url).toBe("/v1/listen?model=nova-3&multichannel=true");
  expect(requests[0]?.audio).toEqual(audioInput);
  return { text, error };
}

// Only the external Deepgram service is replaced. Registration, Nova routing,
// request transport, response parsing, and returned provider result are real.
describe("registered Deepgram multichannel transcription", () => {
  installPinnedHostnameTestHooks();
  it.each([
    {
      name: "both tracks",
      transcripts: ["Left track.", "Right track."],
      expected: "Left track.\n\nRight track.",
    },
    {
      name: "speech after a silent first track",
      transcripts: ["", "Only second track."],
      expected: "Only second track.",
    },
    { name: "single-track control", transcripts: ["Mono unchanged."], expected: "Mono unchanged." },
    {
      name: "identical text on distinct tracks",
      transcripts: ["Repeated.", "Repeated."],
      expected: "Repeated.\n\nRepeated.",
    },
  ])("retains $name", async ({ name, transcripts, expected }) => {
    const { text, error } = await requestTranscript(
      transcripts.map((transcript) => ({
        alternatives: [{ transcript }, { transcript: "Unused alternative hypothesis" }],
      })),
    );
    console.info(
      "DEEPGRAM_CHANNEL_PROOF",
      JSON.stringify({
        name,
        channels: transcripts.length,
        text,
        error: error instanceof Error ? error.message : error,
      }),
    );
    expect(error).toBeUndefined();
    expect(text).toBe(expected);
  });

  it("keeps the no-transcript failure when every channel is silent", async () => {
    const { text, error } = await requestTranscript([
      { alternatives: [{ transcript: "" }] },
      { alternatives: [{ transcript: "   " }] },
    ]);
    expect(text).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("missing transcript");
  });

  it("does not return a partial success for a malformed later transcript", async () => {
    const { text, error } = await requestTranscript([
      { alternatives: [{ transcript: "First track." }] },
      { alternatives: [{ transcript: 42 }] },
    ]);
    expect(text).toBeUndefined();
    expect(String(error)).toContain("malformed JSON response");
  });
});
