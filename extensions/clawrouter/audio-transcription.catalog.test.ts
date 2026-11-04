import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { describe, expect, it } from "vitest";
import {
  type AudioCatalog,
  withClawRouterAudioFixture as fixture,
} from "./audio-transcription.test-support.js";

const senseaudioModel = "senseaudio-asr-pro-1.5-260319";
const senseaudioOffer = {
  provider: "senseaudio",
  model: senseaudioModel,
  responseFormat: "senseaudio.transcription",
};

describe("ClawRouter catalog-scoped multipart transcription", () => {
  it("cancels catalog discovery through the host without uploading audio", async () => {
    const started = createDeferred();
    const closed = createDeferred();
    await fixture(
      async ({ cfg, filePath, catalogRequests, requests }) => {
        const caller = new AbortController();
        const pending = transcribeAudioFile(
          { cfg, filePath },
          { signal: caller.signal, assertCurrent: () => {} },
        );
        const rejection = expect(pending).rejects.toThrow(/abort|cancel/i);
        await started.promise;
        caller.abort();
        await rejection;
        await closed.promise;
        expect(catalogRequests).toEqual(["Bearer fixture-router"]);
        expect(requests).toHaveLength(0);
      },
      undefined,
      (res) => {
        res.setHeader("content-type", "application/json");
        res.write('{"version":"');
        res.once("close", () => closed.resolve());
        started.resolve();
      },
    );
  });

  it.each(["header", "request header", "auth"])(
    "rejects a configured provider credential override in %s before discovery",
    async (override) => {
      await fixture(async ({ cfg, filePath, catalogRequests, requests }) => {
        const provider = cfg.models!.providers!.clawrouter!;
        if (override === "header") {
          provider.headers = { "x-api-key": "fixture-foreign" };
        }
        if (override === "request header") {
          provider.request!.headers = { "content-type": "audio/wav" };
        }
        if (override === "auth") {
          provider.request!.auth = { mode: "authorization-bearer", token: "fixture-foreign" };
        }
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(
          /header overrides|provider-default/,
        );
        expect(catalogRequests).toHaveLength(0);
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.each<[string, Partial<AudioCatalog>]>([
    ["revoked offer", { eligible: false }],
    ["stale observation", { observedAt: "2000-01-01T00:00:00Z" }],
    ["foreign auth scope", { authType: "access" }],
    ["foreign origin", { route: "https://foreign.example/v1/audio/transcriptions" }],
    ["foreign native provider", { route: "/v1/native/senseaudio/v1/audio/transcriptions" }],
    ["unknown request format", { requestFormat: "unknown.transcription" }],
    ["unknown response format", { responseFormat: "unknown.transcription" }],
    ["different route", { path: "/v1/audio/translations" }],
    ["different model", { model: "whisper-1" }],
    ["mismatched upstream model", { upstream: "whisper-1" }],
  ])("denies %s through the actual media runner before upload", async (_name, change) => {
    await fixture(async ({ cfg, filePath, catalog, catalogRequests, requests }) => {
      Object.assign(catalog, change);
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/catalog/);
      expect(catalogRequests).toEqual(["Bearer fixture-router"]);
      expect(requests).toHaveLength(0);
    });
  });

  it("refreshes with the current credential and does not reuse a revoked offer", async () => {
    await fixture(async ({ cfg, filePath, catalog, catalogRequests, requests }) => {
      await transcribeAudioFile({ cfg, filePath });
      catalog.eligible = false;
      cfg.models!.providers!.clawrouter!.apiKey = "fixture-rotated-router";
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/catalog offer/);
      expect(catalogRequests).toEqual(["Bearer fixture-router", "Bearer fixture-rotated-router"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authorization).toBe("Bearer fixture-router");
    });
  });

  it("runs native SenseAudio multipart with model provenance, ISO-639-3 and unchanged bytes", async () => {
    await fixture(async ({ cfg, filePath, catalog, catalogRequests, requests, audio }) => {
      Object.assign(catalog, senseaudioOffer);
      cfg.tools!.media!.models![0]!.model = `senseaudio/${senseaudioModel}`;
      const result = await transcribeAudioFile({
        cfg,
        filePath,
        mime: "audio/wav",
        language: "eng",
        prompt: "synthetic proper noun",
      });
      expect(result).toMatchObject({
        text: "synthetic transcript",
        provider: "clawrouter",
        model: `senseaudio/${senseaudioModel}`,
      });
      expect(catalogRequests).toEqual(["Bearer fixture-router"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/native/senseaudio/v1/audio/transcriptions",
        authorization: "Bearer fixture-router",
      });
      const form = requests[0]!.form;
      expect(form.get("model")).toBe(senseaudioModel);
      expect(form.get("language")).toBe("eng");
      expect(form.get("prompt")).toBe("synthetic proper noun");
      const file = form.get("file") as File;
      expect(file.name).toBe("meeting (1).wav");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    });
  });

  it("keeps native AAC filenames, MIME and ADTS bytes through the actual media runner", async () => {
    await fixture(async ({ cfg, home, catalog, requests }) => {
      Object.assign(catalog, senseaudioOffer);
      cfg.tools!.media!.models![0]!.model = `senseaudio/${senseaudioModel}`;
      // Offline FFmpeg 16 kHz mono silence: one metadata frame and 125 silent ADTS frames.
      const audio = Buffer.concat([
        Buffer.from("//FgQANf/NwATGF2YzYzLjEuMTAyAAIwQA4=", "base64"),
        ...Array.from({ length: 125 }, () => Buffer.from("//FgQAF//AEYIAc=", "base64")),
      ]);
      const filePath = home + "/voice.aac";
      await fs.writeFile(filePath, audio);
      await transcribeAudioFile({ cfg, filePath, mime: "audio/aac" });
      expect(requests).toHaveLength(1);
      const file = requests[0]!.form.get("file") as File;
      expect(file.name).toBe("voice.aac");
      expect(requests[0]!.body.toString("latin1")).toMatch(/content-type: audio\/aac\r\n/i);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    });
  });

  it.each(["missing key", "language", "prompt", "file bytes", "upload format"])(
    "rejects SenseAudio %s before discovery or upload without borrowing the native key",
    async (invalid) => {
      await fixture(
        async ({ cfg, filePath: initialFilePath, catalog, requests, catalogRequests, audio }) => {
          let filePath = initialFilePath;
          Object.assign(catalog, senseaudioOffer);
          cfg.tools!.media!.models![0]!.model = `senseaudio/${senseaudioModel}`;
          if (invalid === "missing key") {
            delete cfg.models!.providers!.clawrouter!.apiKey;
          }
          if (invalid === "file bytes") {
            cfg.tools!.media!.models![0]!.maxBytes = 12_000_000;
            await fs.writeFile(
              filePath,
              Buffer.concat([audio, Buffer.alloc(10_000_001 - audio.length)]),
            );
          }
          if (invalid === "upload format") {
            const nextPath = filePath.replace(/\.wav$/, ".webm");
            await fs.rename(filePath, nextPath);
            filePath = nextPath;
          }
          await expect(
            transcribeAudioFile({
              cfg,
              filePath,
              mime: invalid === "upload format" ? "audio/webm" : undefined,
              language: invalid === "language" ? "en-US" : undefined,
              prompt: invalid === "prompt" ? "x".repeat(16385) : undefined,
            }),
          ).rejects.toThrow(/API key|credential|ISO-639|10000000|MIME/i);
          expect(catalogRequests).toHaveLength(0);
          expect(requests).toHaveLength(0);
        },
      );
    },
  );
});
