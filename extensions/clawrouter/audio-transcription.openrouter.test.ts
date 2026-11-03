import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { describe, expect, it } from "vitest";
import {
  type AudioCatalog,
  withClawRouterAudioFixture as fixture,
} from "./audio-transcription.test-support.js";

const model = "openai/whisper-large-v3-turbo";
type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function openrouterFixture(
  run: (p: Fixture) => Promise<void>,
  respond: (res: ServerResponse) => void = (res) =>
    res.end(JSON.stringify({ text: " native transcript ", model })),
) {
  await fixture(async (p) => {
    Object.assign(p.catalog, {
      provider: "openrouter",
      model,
      // The catalog owns the endpoint id; native path and format identify this operation.
      endpoint: "native-json-stt",
      path: "/api/v1/audio/transcriptions",
      requestFormat: "openrouter.audio_transcription",
      responseFormat: "openrouter.audio_transcription",
    });
    p.cfg.tools!.media!.models![0]!.model = "openrouter/" + model;
    await run(p);
  }, respond);
}

describe("ClawRouter native OpenRouter JSON transcription", () => {
  it.each(["root", "native base"])(
    "uses the actual host, native formatter and selected proxy credential from %s",
    async (base) => {
      await openrouterFixture(
        async ({ cfg, filePath, audio, rawRequests, requests, catalogRequests }) => {
          if (base === "native base") {
            cfg.models!.providers!.clawrouter!.baseUrl += "/v1/native/openrouter/api/v1";
          }
          cfg.tools!.media!.models![0]!.providerOptions = {
            clawrouter: { temperature: 0.25 },
          };
          const result = await transcribeAudioFile({
            cfg,
            filePath,
            mime: "audio/wav",
            language: "en",
          });
          expect(result).toMatchObject({
            text: "native transcript",
            provider: "clawrouter",
            model: "openrouter/" + model,
          });
          expect(catalogRequests).toEqual(["Bearer fixture-router"]);
          expect(requests).toHaveLength(0);
          expect(rawRequests).toHaveLength(1);
          const request = rawRequests[0]!;
          expect(request.url).toBe("/v1/native/openrouter/api/v1/audio/transcriptions");
          expect(request.authorization).toBe("Bearer fixture-router");
          expect(request.contentType).toBe("application/json");
          expect(JSON.parse(request.body.toString("utf8"))).toEqual({
            model,
            input_audio: { data: audio.toString("base64"), format: "wav" },
            language: "en",
            temperature: 0.25,
          });
        },
      );
    },
  );

  it.each<[string, Partial<AudioCatalog>]>([
    ["stale observation", { observedAt: "2000-01-01T00:00:00Z" }],
    ["revoked offer", { eligible: false }],
    ["foreign credential scope", { authType: "access" }],
    ["different model", { upstream: "openai/whisper-1" }],
    ["multipart request", { requestFormat: "openai.audio_transcriptions" }],
    ["unknown response", { responseFormat: "unknown.transcription" }],
    ["wrong API prefix", { path: "/v1/audio/transcriptions" }],
    ["foreign destination", { route: "https://foreign.example/api/v1/audio/transcriptions" }],
  ])("denies %s before JSON upload", async (_name, change) => {
    await openrouterFixture(async ({ cfg, filePath, catalog, rawRequests }) => {
      Object.assign(catalog, change);
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/catalog/);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it.each<NonNullable<AudioTranscriptionRequest["query"]>>([
    { temperature: -0.1 },
    { temperature: 1.1 },
    { temperature: ["0.5"] },
    { model: "openai/whisper-1" },
    { url: "https://audio.example/voice.wav" },
    { provider: "unqualified-provider" },
  ])("rejects unsupported provider options %j before discovery", async (query) => {
    await openrouterFixture(async ({ cfg, filePath, rawRequests, catalogRequests }) => {
      cfg.tools!.media!.models![0]!.providerOptions = { clawrouter: query };
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/OpenRouter/);
      expect(catalogRequests).toHaveLength(0);
      expect(rawRequests).toHaveLength(0);
    });
  });

  it.each(["language", "prompt", "file bytes", "missing proxy key"])(
    "rejects %s before discovery without borrowing the native credential",
    async (invalid) => {
      await openrouterFixture(async ({ cfg, filePath, audio, rawRequests, catalogRequests }) => {
        if (invalid === "missing proxy key") delete cfg.models!.providers!.clawrouter!.apiKey;
        if (invalid === "file bytes") {
          cfg.tools!.media!.models![0]!.maxBytes = 18 * 1024 * 1024;
          const oversized = Buffer.concat([audio, Buffer.alloc(16 * 1024 * 1024)]);
          oversized.writeUInt32LE(oversized.length - 8, 4);
          oversized.writeUInt32LE(oversized.length - 44, 40);
          await fs.writeFile(filePath, oversized);
        }
        await expect(
          transcribeAudioFile({
            cfg,
            filePath,
            language: invalid === "language" ? "eng" : undefined,
            prompt: invalid === "prompt" ? "unsupported hint" : undefined,
          }),
        ).rejects.toThrow(/OpenRouter|16777216|API key|credential/i);
        expect(catalogRequests).toHaveLength(0);
        expect(rawRequests).toHaveLength(0);
      });
    },
  );

  it("treats silence as a nonfatal empty result without repeating the paid upload", async () => {
    await openrouterFixture(
      async ({ cfg, filePath, rawRequests }) => {
        const result = await transcribeAudioFile({ cfg, filePath });
        expect(result.text).toBeUndefined();
        expect(result.decision.outcome).toBe("skipped");
        expect(rawRequests).toHaveLength(1);
      },
      (res) => res.end(JSON.stringify({ text: "   " })),
    );
  });

  it.each([
    ["missing transcript", {}],
    ["model mismatch", { text: "unexpected", model: "other" }],
    ["API error", { text: "unexpected", error: { message: "failed" } }],
    ["invalid text", { text: "\ud800" }],
    ["oversized text", { text: "x".repeat(262145) }],
  ])("rejects %s without replay", async (_name, body) => {
    await openrouterFixture(
      async ({ cfg, filePath, rawRequests }) => {
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/transcription/);
        expect(rawRequests).toHaveLength(1);
      },
      (res) => res.end(JSON.stringify(body)),
    );
  });

  it("redacts reflected proxy credentials from HTTP errors", async () => {
    await openrouterFixture(
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

  it("cancels the actual JSON response through EOF", async () => {
    const started = createDeferred();
    const closed = createDeferred();
    await openrouterFixture(
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
        res.write('{"text":');
        res.once("close", () => closed.resolve());
        started.resolve();
      },
    );
  });

  it("refuses a redirect without resending audio", async () => {
    await openrouterFixture(
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
