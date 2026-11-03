import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { describe, expect, it } from "vitest";
import {
  type AudioCatalog,
  withClawRouterAudioFixture as fixture,
} from "./audio-transcription.test-support.js";

const offer = {
  provider: "deepgram",
  model: "nova-3",
  endpoint: "listen",
  path: "/v1/listen",
  requestFormat: "deepgram.prerecorded",
  responseFormat: "deepgram.prerecorded",
};
const channels = (texts: unknown[]) => ({
  results: {
    channels: texts.map((transcript) => ({
      alternatives: [{ transcript }, { transcript: "unused alternative" }],
    })),
  },
});
type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function deepgramFixture(
  run: (p: Fixture) => Promise<void>,
  respond: (res: ServerResponse) => void = (res) =>
    res.end(JSON.stringify(channels(["native transcript"]))),
) {
  await fixture(async (p) => {
    Object.assign(p.catalog, offer);
    p.cfg.tools!.media!.models![0]!.model = "deepgram/nova-3";
    await run(p);
  }, respond);
}

describe("ClawRouter native Deepgram file transcription", () => {
  it.each([
    ["independent tracks", [" left ", "right"], "left\n\nright"],
    ["silent first track", ["", "right"], "right"],
    ["repeated speech", ["repeat", "repeat"], "repeat\n\nrepeat"],
  ] satisfies [string, string[], string][])(
    "preserves %s through the actual host and native SDK",
    async (_name, texts, expected) => {
      await deepgramFixture(
        async ({ cfg, filePath, audio, rawRequests, requests, catalogRequests }) => {
          cfg.tools!.media!.models![0]!.providerOptions = {
            clawrouter: {
              keyterm: ["synthetic one", "synthetic two"],
              punctuate: false,
              multichannel: true,
            },
          };
          const result = await transcribeAudioFile({
            cfg,
            filePath,
            mime: "audio/wav",
            language: "en",
          });
          expect(result).toMatchObject({
            text: expected,
            provider: "clawrouter",
            model: "deepgram/nova-3",
          });
          expect(catalogRequests).toEqual(["Bearer fixture-router"]);
          expect(requests).toHaveLength(0);
          expect(rawRequests).toHaveLength(1);
          const request = rawRequests[0]!;
          const url = new URL(request.url, "http://fixture.invalid");
          expect(url.pathname).toBe("/v1/native/deepgram/v1/listen");
          expect(url.searchParams.get("model")).toBe("nova-3");
          expect(url.searchParams.get("language")).toBe("en");
          expect(url.searchParams.getAll("keyterm")).toEqual(["synthetic one", "synthetic two"]);
          expect(url.searchParams.get("punctuate")).toBe("false");
          expect(url.searchParams.get("multichannel")).toBe("true");
          expect(request.authorization).toBe("Bearer fixture-router");
          expect(["audio/wav", "audio/wave", "audio/x-wav"]).toContain(request.contentType);
          expect(request.body).toEqual(audio);
        },
        (res) => res.end(JSON.stringify(channels(texts))),
      );
    },
  );

  it.each<[string, Partial<AudioCatalog>]>([
    ["stale catalog", { observedAt: "2000-01-01T00:00:00Z" }],
    ["revoked offer", { eligible: false }],
    ["different model", { upstream: "flux-general-en" }],
    ["multipart format", { requestFormat: "openai.audio_transcriptions" }],
    ["unknown response", { responseFormat: "unknown.transcription" }],
    ["foreign destination", { route: "https://foreign.example/v1/listen" }],
  ])("denies %s before raw upload", async (_name, change) => {
    await deepgramFixture(async ({ cfg, filePath, catalog, rawRequests }) => {
      Object.assign(catalog, change);
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/catalog/);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it.each<NonNullable<AudioTranscriptionRequest["query"]>>([
    { callback: "https://callback.example" },
    { keywords: ["unsupported legacy hint"] },
    { url: "https://audio.example/file.wav" },
    { model: "flux-general-en" },
    { smart_format: 1 },
    { sample_rate: 0 },
    { channels: ["1", "2"] },
    { keyterm: ["x".repeat(2049)] },
    { tag: Array.from({ length: 128 }, () => "synthetic") },
  ])("rejects unsupported native input %j before discovery", async (query) => {
    await deepgramFixture(async ({ cfg, filePath, rawRequests, catalogRequests }) => {
      cfg.tools!.media!.models![0]!.providerOptions = { clawrouter: query };
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/Deepgram/);
      expect(catalogRequests).toHaveLength(0);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it("rejects prompt hints instead of silently dropping them", async () => {
    await deepgramFixture(async ({ cfg, filePath, rawRequests, catalogRequests }) => {
      await expect(
        transcribeAudioFile({ cfg, filePath, prompt: "synthetic hint" }),
      ).rejects.toThrow(/prompts/);
      expect(catalogRequests).toHaveLength(0);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it("does not borrow the native Deepgram key when the proxy credential is absent", async () => {
    await deepgramFixture(async ({ cfg, filePath, rawRequests, catalogRequests }) => {
      delete cfg.models!.providers!.clawrouter!.apiKey;
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/API key|credential/i);
      expect(catalogRequests).toHaveLength(0);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it.each([
    ["missing", channels([undefined])],
    ["malformed track", channels(["first", 42])],
  ])("rejects %s native results without repeating the upload", async (_name, payload) => {
    await deepgramFixture(
      async ({ cfg, filePath, rawRequests }) => {
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/transcript|JSON/);
        expect(rawRequests).toHaveLength(1);
      },
      (res) => res.end(JSON.stringify(payload)),
    );
  });

  it("redacts proxy credentials from provider errors without upload replay", async () => {
    await deepgramFixture(
      async ({ cfg, filePath, rawRequests }) => {
        const error = await transcribeAudioFile({ cfg, filePath }).catch((error: unknown) => error);
        expect(String(error)).toMatch(/401/);
        expect(String(error)).not.toContain("fixture-router");
        expect(rawRequests).toHaveLength(1);
      },
      (res) => {
        res.statusCode = 401;
        res.end('{"error":"Bearer fixture-router rejected"}');
      },
    );
  });

  it("cancels the native response through EOF and closes the socket", async () => {
    const started = createDeferred();
    const closed = createDeferred();
    await deepgramFixture(
      async ({ cfg, filePath, rawRequests }) => {
        const caller = new AbortController();
        const pending = transcribeAudioFile(
          { cfg, filePath },
          { signal: caller.signal, assertCurrent: () => {} },
        );
        const rejected = expect(pending).rejects.toThrow(/abort|cancel/i);
        await started.promise;
        caller.abort();
        await rejected;
        await closed.promise;
        expect(rawRequests).toHaveLength(1);
      },
      (res) => {
        res.setHeader("content-type", "application/json");
        res.write('{"results":');
        res.once("close", () => closed.resolve());
        started.resolve();
      },
    );
  });

  it("does not resend raw audio through an HTTP redirect", async () => {
    await deepgramFixture(
      async ({ cfg, filePath, rawRequests }) => {
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/fetch|redirect/i);
        expect(rawRequests).toHaveLength(1);
      },
      (res) => {
        res.statusCode = 307;
        res.setHeader("location", "/redirected");
        res.end();
      },
    );
  });
});
