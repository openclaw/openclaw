import { expectDefined } from "@openclaw/normalization-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const providers: SpeechProviderPlugin[] = [];
plugin.register(
  createTestPluginApi({
    registerSpeechProvider: (provider) => {
      if (typeof provider === "function") {
        throw new Error("Expected Azure Speech to register its provider instance");
      }
      providers.push(provider);
    },
  }),
);
const provider = expectDefined(providers[0], "registered Azure Speech provider");
const resolveTalkConfig = expectDefined(
  provider.resolveTalkConfig,
  "Azure Talk configuration resolver",
);
const resolveConfig = expectDefined(provider.resolveConfig, "Azure TTS configuration resolver");

describe("registered Azure Talk endpoint inheritance", () => {
  installPinnedHostnameTestHooks();

  beforeEach(() => {
    for (const key of [
      "AZURE_SPEECH_KEY",
      "AZURE_SPEECH_API_KEY",
      "SPEECH_KEY",
      "AZURE_SPEECH_REGION",
      "SPEECH_REGION",
      "AZURE_SPEECH_ENDPOINT",
    ]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "explicit TTS endpoint with a region",
      base: {
        region: "eastus",
        endpoint: "https://speech.example.com/custom/cognitiveservices/v1",
      },
      talk: {},
      expected: "https://speech.example.com/custom",
    },
    {
      name: "explicit TTS base URL with a region",
      base: { region: "eastus", baseUrl: "https://speech.example.com/custom/" },
      talk: {},
      expected: "https://speech.example.com/custom",
    },
    {
      name: "voice-only Talk override",
      base: { region: "eastus", baseUrl: "https://speech.example.com/custom" },
      talk: { voiceId: "en-US-AriaNeural" },
      expected: "https://speech.example.com/custom",
    },
    {
      name: "endpoint-only inheritance control",
      base: { endpoint: "https://speech.example.com/custom" },
      talk: {},
      expected: "https://speech.example.com/custom",
    },
    {
      name: "region-only inheritance control",
      base: { region: "eastus" },
      talk: {},
      expected: "https://eastus.tts.speech.microsoft.com",
    },
    {
      name: "explicit Talk endpoint control",
      base: { region: "eastus", baseUrl: "https://speech.example.com/custom" },
      talk: { endpoint: "https://talk.example.com/speech/cognitiveservices/v1/" },
      expected: "https://talk.example.com/speech",
    },
    {
      name: "explicit Talk base URL control",
      base: { region: "eastus", baseUrl: "https://speech.example.com/custom" },
      talk: { baseUrl: "https://talk.example.com/speech/" },
      expected: "https://talk.example.com/speech",
    },
    {
      name: "explicit Talk region control",
      base: { region: "eastus", baseUrl: "https://speech.example.com/custom" },
      talk: { region: "westus" },
      expected: "https://westus.tts.speech.microsoft.com",
    },
  ])("preserves $name through synthesis", async ({ name, base, talk, expected }) => {
    const actualFetch = globalThis.fetch;
    const intendedUrls: string[] = [];
    const received: {
      method?: string;
      body: string;
      contentType?: string;
      authorization?: string;
    }[] = [];
    const audio = Buffer.alloc(108);
    audio.write("RIFF");
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24);
    audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(audio.length - 44, 40);

    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push({
            method: req.method,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: req.headers["content-type"],
            authorization: String(req.headers["ocp-apim-subscription-key"] ?? ""),
          });
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(audio);
        });
      },
      async (loopbackUrl) => {
        // Replace only the external endpoint/DNS boundary. Keep the configured
        // route observable and send the actual synthesized SSML over loopback HTTP.
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>((input, init) => {
            intendedUrls.push(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            return actualFetch(loopbackUrl, {
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
              signal: init?.signal,
            });
          }),
        );
        const talkConfig = resolveTalkConfig({
          cfg: {},
          baseTtsConfig: {
            providers: {
              "azure-speech": {
                apiKey: "synthetic-key",
                outputFormat: "riff-16khz-16bit-mono-pcm",
                ...base,
              },
            },
          },
          talkProviderConfig: talk,
          timeoutMs: 5000,
        });
        // The Gateway places the Talk resolver output back in the TTS provider
        // configuration before synthesis; exercise that normalization as well.
        const providerConfig = resolveConfig({
          cfg: {},
          rawConfig: { providers: { "azure-speech": talkConfig } },
          timeoutMs: 5000,
        });
        const result = await provider.synthesize({
          text: "Check the selected endpoint.",
          cfg: {},
          providerConfig,
          target: "audio-file",
          timeoutMs: 5000,
        });
        expect(result.audioBuffer).toEqual(audio);
        expect(result.fileExtension).toBe(".wav");
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          method: "POST",
          contentType: "application/ssml+xml",
          authorization: "synthetic-key",
        });
        expect(received[0]?.body).toContain("Check the selected endpoint.");
        console.info("AZURE_TALK_ROUTE_PROOF", JSON.stringify({ name, expected, intendedUrls }));
        expect(intendedUrls).toEqual([`${expected}/cognitiveservices/v1`]);
      },
    );
  });
});
