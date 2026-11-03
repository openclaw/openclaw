import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { upsertAuthProfileAsync, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { speech, withFixture, withoutKey, type Fixture } from "./speech-provider.test-support.js";

function selectElevenLabs(fixture: Fixture) {
  Object.assign(fixture.catalog, {
    providerId: "elevenlabs",
    model: null,
    path: "/v1/text-to-speech/${voice_id}",
    requestFormat: "elevenlabs.speech",
    responseFormat: "audio.binary",
    routeKind: "native",
  });
  return {
    ...fixture.cfg,
    agents: { defaults: {} },
    tts: {
      provider: "clawrouter",
      providers: {
        clawrouter: { upstreamProvider: "elevenlabs", voiceId: "syntheticVoice1234567" },
      },
    },
  } satisfies OpenClawConfig;
}
// PR461 offline-generated 44.1 kHz mono 128 kbit/s MP3; no paid provider request.
const ELEVENLABS_MP3 = Buffer.from(
  "//uQxAADwAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uSxDkDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7ksQ5A8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=",
  "base64",
);
function respondElevenLabs(res: ServerResponse) {
  res.setHeader("content-type", "audio/mpeg");
  res.end(ELEVENLABS_MP3);
}

describe("ClawRouter native ElevenLabs speech", () => {
  it.each(["native", "manifest"] as const)(
    "runs actual TTS with %s voice and query bindings",
    async (routeKind) => {
      await withFixture(async (fixture) => {
        const cfg = selectElevenLabs(fixture);
        fixture.catalog.routeKind = routeKind;
        cfg.models!.providers!.clawrouter!.headers = {
          "xi-api-key": "synthetic-upstream-not-router",
          "x-api-key": "synthetic-other-key",
        };
        Object.assign(cfg.tts.providers.clawrouter, {
          seed: 42,
          languageCode: "en",
          applyTextNormalization: "auto",
          latencyTier: 2,
          voiceSettings: {
            stability: 0.4,
            similarityBoost: 0.7,
            style: 0.1,
            useSpeakerBoost: false,
            speed: 1.2,
          },
        });
        const result = await fixture.tts({ cfg, text: "Synthetic café 😀" });
        expect(result).toMatchObject({
          success: true,
          audioBuffer: ELEVENLABS_MP3,
          outputFormat: "mp3_44100_128",
          voiceCompatible: false,
        });
        expect(fixture.catalogRequests).toEqual(["Bearer fixture-router"]);
        const body = {
          text: "Synthetic café 😀",
          model_id: "eleven_multilingual_v2",
          seed: 42,
          language_code: "en",
          apply_text_normalization: "auto",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.7,
            style: 0.1,
            use_speaker_boost: false,
            speed: 1.2,
          },
        };
        expect(fixture.requests).toEqual([
          {
            auth: "Bearer fixture-router",
            vendorKey: undefined,
            url:
              routeKind === "native"
                ? "/v1/native/elevenlabs/v1/text-to-speech/syntheticVoice1234567?output_format=mp3_44100_128&optimize_streaming_latency=2"
                : "/v1/proxy/elevenlabs/speech",
            body:
              routeKind === "native"
                ? body
                : {
                    body,
                    pathParams: { voice_id: "syntheticVoice1234567" },
                    query: { output_format: "mp3_44100_128", optimize_streaming_latency: "2" },
                  },
          },
        ]);
      }, respondElevenLabs);
    },
  );

  it.each(["native", "manifest"] as const)(
    "applies explicit TTS voice overrides after configured speaker selection on %s",
    async (routeKind) => {
      await withFixture(async (fixture) => {
        const cfg = selectElevenLabs(fixture);
        fixture.catalog.routeKind = routeKind;
        Object.assign(cfg.tts.providers.clawrouter, {
          speakerVoiceId: "syntheticSpeaker123",
        });
        expect((await fixture.tts({ cfg })).success).toBe(true);
        expect(fixture.requests[0]).toMatchObject(
          routeKind === "native"
            ? {
                url: "/v1/native/elevenlabs/v1/text-to-speech/syntheticSpeaker123?output_format=mp3_44100_128",
              }
            : { body: { pathParams: { voice_id: "syntheticSpeaker123" } } },
        );
        const synthesize = (voice: string) =>
          fixture.tts({
            cfg,
            overrides: { providerOverrides: { clawrouter: { voice } } },
          });
        expect((await synthesize("syntheticOverride123")).success).toBe(true);
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[1]).toMatchObject(
          routeKind === "native"
            ? {
                url: "/v1/native/elevenlabs/v1/text-to-speech/syntheticOverride123?output_format=mp3_44100_128",
              }
            : { body: { pathParams: { voice_id: "syntheticOverride123" } } },
        );
        expect((await synthesize("../foreign")).success).toBe(false);
        expect(fixture.catalogRequests).toEqual(["Bearer fixture-router", "Bearer fixture-router"]);
        expect(fixture.requests).toHaveLength(2);
      }, respondElevenLabs);
    },
  );

  it.each([
    { observedAt: "2000-01-01T00:00:00Z" },
    { authType: "access" },
    { eligible: false },
    { providerId: "openai" as const },
    { model: "eleven_multilingual_v2" },
    { requestFormat: "unknown.speech" },
    { responseFormat: "openai.audio_speech" },
    { route: "https://foreign.example/speech" },
    { path: "/v1/text-to-speech/${voice_id}/stream" },
    { path: "/v1/text-to-speech/${model}" },
  ])("denies unqualified catalog offers before TTS dispatch (%j)", async (patch) => {
    await withFixture(async (fixture) => {
      const cfg = selectElevenLabs(fixture);
      Object.assign(fixture.catalog, patch);
      expect((await fixture.tts({ cfg })).success).toBe(false);
      expect(fixture.requests).toHaveLength(0);
    }, respondElevenLabs);
  });

  it.each([
    { voiceId: "../foreign" },
    { voiceId: "short" },
    { model: "unqualified" },
    { outputFormat: "opus_48000_64" },
    { responseFormat: "mp3" },
    { latencyTier: "2" },
    { latencyTier: 5 },
    { model: "eleven_v3", latencyTier: 1 },
    { seed: -1 },
    { languageCode: "english" },
    { applyTextNormalization: "guess" },
    { voiceSettings: { speed: 3 } },
    { voiceSettings: { invented: 1 } },
    { voiceSettings: { useSpeakerBoost: "yes" } },
    { stream: true },
    { query: { api_key: "synthetic" } },
    { instructions: "whisper" },
  ])("rejects unsupported native input before discovery (%j)", async (override) => {
    await withFixture(async (fixture) => {
      const cfg = selectElevenLabs(fixture);
      Object.assign(cfg.tts.providers.clawrouter, override);
      expect((await fixture.tts({ cfg })).success).toBe(false);
      expect(fixture.catalogRequests).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    }, respondElevenLabs);
  });

  it("keeps missing and foreign profiles terminal without borrowing the native vendor key", async () => {
    await withFixture(async (fixture) => {
      const cfg = selectElevenLabs(fixture);
      expect((await fixture.tts({ cfg: withoutKey(cfg) })).success).toBe(false);
      await upsertAuthProfileAsync({
        agentDir: fixture.home + "/.openclaw/agents/main/agent",
        profileId: "elevenlabs:speech",
        credential: { type: "api_key", provider: "elevenlabs", key: "synthetic-native-vendor" },
      });
      for (const profileId of ["clawrouter:missing", "elevenlabs:speech"]) {
        Object.assign(cfg.tts.providers.clawrouter, { profileId });
        expect((await fixture.tts({ cfg })).success).toBe(false);
      }
      expect(fixture.catalogRequests).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    }, respondElevenLabs);
  });

  it("rejects voice notes, telephony and malformed Unicode without a POST", async () => {
    await withFixture(async (fixture) => {
      const cfg = selectElevenLabs(fixture),
        provider = speech(cfg);
      for (const target of ["voice-note", "telephony"] as const) {
        await expect(
          provider.synthesize({ ...fixture.request(cfg.tts.providers.clawrouter), cfg, target }),
        ).rejects.toThrow("not qualified");
      }
      for (const text of [" ", "\ud800", "😀".repeat(10001)]) {
        await expect(
          provider.synthesize({ ...fixture.request(cfg.tts.providers.clawrouter), cfg, text }),
        ).rejects.toThrow("valid Unicode");
      }
      expect(fixture.catalogRequests).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    }, respondElevenLabs);
  });

  it.each([
    "mime",
    "empty",
    "partial",
    "truncated",
    "oversized",
    "redirect",
    "range",
    "encoding",
  ] as const)("rejects %s output without replay", async (failure) => {
    await withFixture(
      async (fixture) => {
        expect((await fixture.tts({ cfg: selectElevenLabs(fixture) })).success).toBe(false);
        expect(fixture.requests).toHaveLength(1);
      },
      (res) => {
        res.setHeader("content-type", failure === "mime" ? "audio/ogg" : "audio/mpeg");
        if (failure === "partial") {
          res.statusCode = 206;
        }
        if (failure === "range") {
          res.setHeader("content-range", "bytes 0-15/100");
        }
        if (failure === "encoding") {
          res.setHeader("content-encoding", "gzip");
        }
        if (failure === "truncated") {
          res.setHeader("content-length", ELEVENLABS_MP3.length + 1);
          res.setHeader("connection", "close");
        }
        if (failure === "oversized") {
          res.setHeader("content-length", 16 * 1024 * 1024 + 1);
        }
        if (failure === "redirect") {
          res.statusCode = 307;
          res.setHeader("location", "/replayed-speech");
        }
        res.end(failure === "empty" ? undefined : ELEVENLABS_MP3);
      },
    );
  });
  it("aborts incomplete ElevenLabs delivery at the caller deadline without replay", async () => {
    const closed = createDeferred();
    await withFixture(
      async (fixture) => {
        const cfg = selectElevenLabs(fixture);
        await expect(
          speech(cfg).synthesize({
            ...fixture.request(cfg.tts.providers.clawrouter),
            cfg,
            timeoutMs: 250,
          }),
        ).rejects.toThrow(/timed out|abort/i);
        expect(fixture.requests).toHaveLength(1);
        await closed.promise;
      },
      (res) => {
        res.setHeader("content-type", "audio/mpeg");
        res.write(ELEVENLABS_MP3.subarray(0, 1));
        res.once("close", () => closed.resolve());
      },
    );
  });
});
