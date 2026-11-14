import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { upsertAuthProfileAsync, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { getSpeechProvider, type SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech, textToSpeechTelephony } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";

const AUDIO = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
type Request = { url: string; auth?: string; vendorKey?: string; body: Record<string, unknown> };
type Catalog = {
  providerId: "openai" | "gradium";
  model: string | null;
  observedAt?: string;
  authType?: string;
  path?: string;
  routeKind: "unified" | "native" | "manifest";
  eligible: boolean;
  requestFormat: string;
  responseFormat: string;
  route?: string;
};
type Fixture = {
  catalog: Catalog;
  catalogRequests: string[];

  cfg: OpenClawConfig;
  home: string;
  requests: Request[];
  arrivals: Array<{
    method: string | undefined;
    responseClosed: boolean;
    socketClosed: boolean;
    retired: Promise<unknown>;
  }>;
  request: (providerConfig?: Record<string, unknown>) => SpeechSynthesisRequest;
  tts: (
    options?: Partial<Parameters<typeof synthesizeSpeech>[0]>,
  ) => ReturnType<typeof synthesizeSpeech>;
};
const withoutKey = (cfg: OpenClawConfig): OpenClawConfig => ({
  ...cfg,
  models: {
    providers: {
      clawrouter: {
        baseUrl: cfg.models?.providers?.clawrouter?.baseUrl ?? "",
        models: [],
        request: { allowPrivateNetwork: true },
      },
    },
  },
});

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  respond: (res: ServerResponse, req: Request) => void = (res) => {
    res.setHeader("content-type", "audio/mpeg");
    res.end(AUDIO);
  },
  routerApiKey?: string,
) {
  await withTempHome(
    async (home) => {
      const requests: Request[] = [];
      const arrivals: Fixture["arrivals"] = [];
      const catalogRequests: string[] = [];
      const catalog: Catalog = {
        providerId: "openai",
        model: "tts-1",
        routeKind: "unified",
        eligible: true,
        requestFormat: "openai.audio_speech",
        responseFormat: "audio.binary",
      };
      await withServer(
        (req, res) => {
          const responseClosed = createDeferred();
          const socketClosed = createDeferred();
          const arrival = {
            method: req.method,
            responseClosed: false,
            socketClosed: false,
            retired: Promise.all([responseClosed.promise, socketClosed.promise]),
          };
          arrivals.push(arrival);
          res.once("close", () => {
            arrival.responseClosed = true;
            responseClosed.resolve();
          });
          req.socket.once("close", () => {
            arrival.socketClosed = true;
            socketClosed.resolve();
          });
          void (async () => {
            if (req.url === "/v1/catalog") {
              catalogRequests.push(req.headers.authorization ?? "");
              const route =
                catalog.route ??
                (catalog.routeKind === "unified"
                  ? "/v1/audio/speech"
                  : catalog.routeKind === "native"
                    ? `/v1/native/${catalog.providerId}${catalog.path ?? (catalog.providerId === "gradium" ? "/api/post/speech/tts" : "/v1/audio/speech")}`
                    : `/v1/proxy/${catalog.providerId}/speech`);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  version: "clawrouter.client-catalog.v1",
                  observedAt: catalog.observedAt ?? new Date().toISOString(),
                  scope: {
                    authType: catalog.authType ?? "proxy_key",
                    credentialId: "synthetic-router-id",
                    principalId: null,
                  },
                  providers: [
                    {
                      id: catalog.providerId,
                      allowed: true,
                      executable: true,
                      nativeBaseUrl: `/v1/native/${catalog.providerId}`,
                      routes: [
                        {
                          endpoint: "speech",
                          path:
                            catalog.path ??
                            (catalog.providerId === "gradium"
                              ? "/api/post/speech/tts"
                              : "/v1/audio/speech"),
                          methods: ["POST"],
                          requestFormat: catalog.requestFormat,
                          responseFormat: catalog.responseFormat,
                        },
                      ],
                      models:
                        catalog.model === null
                          ? []
                          : [
                              {
                                id: catalog.providerId + "/" + catalog.model,
                                upstream: catalog.model,
                                capabilities: ["audio.speech"],
                              },
                            ],
                      offers: [
                        {
                          endpoint: "speech",
                          modelId:
                            catalog.model === null
                              ? null
                              : catalog.providerId + "/" + catalog.model,
                          routeKind: catalog.routeKind,
                          route,
                          transport: "http",
                          eligible: catalog.eligible,
                          affordability: "request-dependent",
                        },
                      ],
                    },
                  ],
                }),
              );
              return;
            }
            let text = "";
            for await (const chunk of req) {
              text += chunk;
            }
            const request = {
              url: req.url ?? "",
              auth: req.headers.authorization,
              vendorKey:
                typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
              body: text ? JSON.parse(text) : {},
            };
            requests.push(request);
            respond(res, request);
          })().catch((error: unknown) => {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          });
        },
        async (baseUrl) => {
          const cfg: OpenClawConfig = {
            plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
            agents: { defaults: { voiceModel: "clawrouter/openai/tts-1" } },
            models: {
              providers: {
                clawrouter: {
                  baseUrl,
                  apiKey: "fixture-router",
                  models: [],
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            tts: { providers: { clawrouter: {} } },
          };
          await run({
            cfg,
            home,
            requests,
            arrivals,
            catalog,
            catalogRequests,
            tts: (options = {}) =>
              synthesizeSpeech({
                text: "Hello from ClawRouter",
                cfg,
                prefsPath: home + "/tts-prefs.json",
                disableFallback: true,
                ...options,
              }),
            request: (providerConfig = {}) => ({
              cfg,
              providerConfig,
              text: "Hello from ClawRouter",
              target: "audio-file",
              timeoutMs: 5000,
            }),
          });
        },
      );
    },
    {
      env: {
        CLAWROUTER_API_KEY: routerApiKey,
        OPENAI_API_KEY: "fixture-openai-not-router",
        GRADIUM_API_KEY: "fixture-gradium-not-router",
      },
    },
  );
}

function speech(cfg: OpenClawConfig) {
  return getSpeechProvider("clawrouter", cfg)!;
}

describe("ClawRouter native speech", () => {
  it.each(["native", "manifest"] as const)(
    "runs a catalog-selected %s offer through actual TTS",
    async (routeKind) => {
      await withFixture(async ({ cfg, catalog, catalogRequests, requests, tts }) => {
        catalog.routeKind = routeKind;
        catalog.model = "gpt-4o-mini-tts";
        const result = await tts({
          cfg: {
            ...cfg,
            agents: { defaults: {} },
            tts: {
              provider: "clawrouter",
              providers: {
                clawrouter: {
                  model: "openai/gpt-4o-mini-tts",
                  voice: "coral",
                  instructions: "Speak softly",
                },
              },
            },
          },
        });
        expect(result).toMatchObject({ success: true, audioBuffer: AUDIO });
        expect(catalogRequests).toEqual(["Bearer fixture-router"]);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          url:
            routeKind === "native"
              ? "/v1/native/openai/v1/audio/speech"
              : "/v1/proxy/openai/speech",
          auth: "Bearer fixture-router",
          body:
            routeKind === "manifest"
              ? {
                  body: {
                    model: "gpt-4o-mini-tts",
                    input: "Hello from ClawRouter",
                    voice: "coral",
                    instructions: "Speak softly",
                    response_format: "mp3",
                  },
                }
              : {
                  model: "gpt-4o-mini-tts",
                  input: "Hello from ClawRouter",
                  voice: "coral",
                  instructions: "Speak softly",
                  response_format: "mp3",
                },
        });
      });
    },
  );

  it("refreshes grants and refuses unsupported formats or credential-bearing destinations before synthesis", async () => {
    await withFixture(async ({ cfg, request, catalog, requests, catalogRequests }) => {
      const provider = speech(cfg);
      await provider.synthesize(request({ instructions: "tts-1 cannot accept this" }));
      expect(requests[0]?.body).not.toHaveProperty("instructions");
      catalog.eligible = false;
      await expect(provider.synthesize(request())).rejects.toThrow("no eligible supported offer");
      catalog.eligible = true;
      catalog.requestFormat = "future.speech";
      await expect(provider.synthesize(request())).rejects.toThrow("no eligible supported offer");
      catalog.requestFormat = "openai.audio_speech";
      catalog.responseFormat = "application.json";
      await expect(provider.synthesize(request())).rejects.toThrow("no eligible supported offer");
      catalog.responseFormat = "audio.binary";
      catalog.route = "https://untrusted.example/audio/speech";
      await expect(provider.synthesize(request())).rejects.toThrow("no eligible supported offer");
      expect(catalogRequests).toHaveLength(5);
      expect(requests).toHaveLength(1);
    });
  });

  it("selects the qualified voice model through native TTS, without a chat provider selection", async () => {
    await withFixture(async ({ tts, requests }) => {
      const result = await tts();
      expect(result).toMatchObject({
        success: true,
        provider: "clawrouter",
        providerModel: "openai/tts-1",
        outputFormat: "mp3",
        fileExtension: ".mp3",
        audioBuffer: AUDIO,
      });
      expect(requests).toEqual([
        {
          url: "/v1/audio/speech",
          auth: "Bearer fixture-router",
          body: {
            model: "openai/tts-1",
            input: "Hello from ClawRouter",
            voice: "alloy",
            response_format: "mp3",
          },
        },
      ]);
    });
  });

  it("applies Talk config, canonical speaker selection and per-call overrides through TTS", async () => {
    await withFixture(
      async ({ cfg, tts, requests }) => {
        const provider = speech(cfg);
        const talkProviderConfig = {
          modelId: "openai/tts-1",
          speakerVoiceId: "shimmer",
          responseFormat: "wav",
          speed: 0.75,
        };
        const providerConfig = provider.resolveTalkConfig!({
          cfg,
          baseTtsConfig: { providers: { clawrouter: { voice: "alloy" } } },
          talkProviderConfig,
          timeoutMs: 5000,
        });
        const overrides = provider.resolveTalkOverrides!({
          talkProviderConfig,
          params: { voiceId: "nova", speed: 1.25 },
        });
        if (!overrides) {
          throw new Error("ClawRouter Talk overrides missing");
        }
        const result = await tts({
          cfg: {
            ...cfg,
            tts: { provider: "clawrouter", providers: { clawrouter: providerConfig } },
          },
          text: "Talk route",
          overrides: {
            provider: "clawrouter",
            providerOverrides: { clawrouter: overrides },
          },
        });
        expect(result).toMatchObject({
          success: true,
          outputFormat: "wav",
          fileExtension: ".wav",
          audioBuffer: AUDIO,
        });
        expect(requests[0]?.body).toEqual({
          model: "openai/tts-1",
          input: "Talk route",
          voice: "nova",
          speed: 1.25,
          response_format: "wav",
        });
      },
      (res) => {
        res.setHeader("content-type", "audio/wav");
        res.end(AUDIO);
      },
    );
  });

  it("delivers each binary format and defaults voice notes to Opus", async () => {
    await withFixture(
      async ({ cfg, request, requests }) => {
        const provider = speech(cfg);
        for (const format of ["mp3", "opus", "aac", "flac", "wav", "pcm"]) {
          const result = await provider.synthesize(request({ responseFormat: format }));
          expect(result).toEqual({
            audioBuffer: AUDIO,
            outputFormat: format,
            fileExtension: "." + format,
            voiceCompatible: format === "opus",
          });
        }
        const note = await provider.synthesize({ ...request(), target: "voice-note" });
        expect(note).toMatchObject({
          outputFormat: "opus",
          voiceCompatible: true,
          audioBuffer: AUDIO,
        });
        expect(requests.at(-1)?.body.response_format).toBe("opus");
      },
      (res, req) => {
        res.setHeader(
          "content-type",
          req.body.response_format === "pcm" ? "application/octet-stream" : "audio/mpeg",
        );
        res.end(AUDIO);
      },
    );
  });

  it("returns 24 kHz PCM through native telephony", async () => {
    const silence = Buffer.alloc(4800); // 100 ms signed 16-bit mono at 24 kHz.
    await withFixture(
      async ({ cfg, home, requests }) => {
        const result = await textToSpeechTelephony({
          text: "Phone route",
          cfg,
          prefsPath: home + "/tts-prefs.json",
        });
        expect(result).toMatchObject({
          success: true,
          provider: "clawrouter",
          outputFormat: "pcm",
          sampleRate: 24000,
          audioBuffer: silence,
        });
        expect(requests[0]?.body.response_format).toBe("pcm");
      },
      (res) => {
        res.setHeader("content-type", "application/octet-stream");
        res.end(silence);
      },
    );
  });

  it("honors explicit speech keys over ambient auth while keeping selected profiles terminal", async () => {
    await withFixture(
      async ({ cfg, home, tts, requests, request }) => {
        const agentDir = home + "/.openclaw/agents/main/agent";
        await upsertAuthProfileAsync({
          agentDir,
          profileId: "clawrouter:speech",
          credential: { type: "api_key", provider: "clawrouter", key: "fixture-stored-router" },
        });
        await upsertAuthProfileAsync({
          agentDir,
          profileId: "openai:speech",
          credential: { type: "api_key", provider: "openai", key: "fixture-stored-openai" },
        });
        const provider = speech(cfg);
        const storedCfg = withoutKey(cfg);
        await expect(tts({ cfg: storedCfg, timeoutMs: 5000 })).resolves.toMatchObject({
          audioBuffer: AUDIO,
        });
        await expect(
          provider.synthesize(
            request({ profileId: "clawrouter:speech", apiKey: "fixture-inline-must-not-win" }),
          ),
        ).resolves.toMatchObject({ audioBuffer: AUDIO });
        for (const profileId of ["clawrouter:missing", "openai:speech"]) {
          await expect(provider.synthesize(request({ profileId }))).rejects.toThrow(
            "Selected speech auth profile is unavailable for ClawRouter",
          );
        }
        for (const route of ["tts", "talk"] as const) {
          const apiKey = "fixture-explicit-" + route;
          const providerConfig =
            route === "talk"
              ? provider.resolveTalkConfig!({
                  cfg,
                  baseTtsConfig: { providers: { clawrouter: {} } },
                  talkProviderConfig: { apiKey },
                  timeoutMs: 5000,
                })
              : { apiKey };
          const result = await tts({
            cfg: { ...cfg, tts: { providers: { clawrouter: providerConfig } } },
            text: "Explicit " + route + " key",
          });
          expect(result).toMatchObject({ success: true, audioBuffer: AUDIO });
        }
        expect(requests.map((req) => req.auth)).toEqual([
          "Bearer fixture-stored-router",
          "Bearer fixture-stored-router",
          "Bearer fixture-explicit-tts",
          "Bearer fixture-explicit-talk",
        ]);
      },
      undefined,
      "fixture-env-router",
    );
  });

  it("never borrows an OpenAI credential and preserves service grant failures without exposing keys", async () => {
    await withFixture(
      async ({ cfg, tts, request, requests }) => {
        const noKeyCfg = withoutKey(cfg);
        await expect(speech(cfg).synthesize({ ...request(), cfg: noKeyCfg })).rejects.toThrow(
          /No API key|Configure a ClawRouter/i,
        );
        expect(requests).toHaveLength(0);
        const result = await tts({ text: "Denied" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("403");
        expect(result.error).toContain("speech grant required");
        expect(result.error).not.toContain("fixture-router");
        expect(result.error).not.toContain("fixture-openai");
        expect(requests).toHaveLength(1);
      },
      (res, req) => {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.setHeader("x-request-id", "speech-fixture-request");
        res.end(JSON.stringify({ error: { message: "speech grant required " + req.auth } }));
      },
    );
  });

  it("enforces the configured audio response byte limit through TTS", async () => {
    await withFixture(async ({ cfg, tts }) => {
      const limited: OpenClawConfig = {
        ...cfg,
        agents: { defaults: { ...cfg.agents?.defaults, mediaMaxMb: 4 / (1024 * 1024) } },
      };
      const result = await tts({ cfg: limited, text: "Bad response" });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toContain("exceeds configured limit");
    });
  });

  it("expires the whole registered speech operation and retires any started requests", async () => {
    await withFixture(
      async ({ cfg, request, requests, arrivals }) => {
        await expect(speech(cfg).synthesize({ ...request(), timeoutMs: 250 })).rejects.toThrow(
          /timed out|abort/i,
        );
        // Preparation can consume the budget before dispatch; this is not body-retirement proof.
        expect(arrivals.filter((arrival) => arrival.method === "POST").length).toBeLessThanOrEqual(
          1,
        );
        expect(requests.length).toBeLessThanOrEqual(1);
        await Promise.all(arrivals.map((arrival) => arrival.retired));
        expect(arrivals.every((arrival) => arrival.responseClosed && arrival.socketClosed)).toBe(
          true,
        );
      },
      (res) => {
        res.setHeader("content-type", "audio/mpeg");
        res.write(AUDIO.subarray(0, 1));
      },
    );
  });

  it("checks the tts-1 request contract before dispatch, counting Unicode code points", async () => {
    await withFixture(async ({ cfg, request, requests }) => {
      const provider = speech(cfg);
      for (const [config, message] of [
        [{ model: "tts-1" }, "requires a qualified OpenAI speech model"],
        [{ voice: "unknown" }, "Invalid ClawRouter OpenAI speech voice"],
        [{ speed: 0 }, "speed must be between 0.25 and 4"],
        [{ responseFormat: "json" }, "Invalid ClawRouter speech responseFormat"],
      ] as const) {
        await expect(provider.synthesize(request(config))).rejects.toThrow(message);
      }
      await expect(provider.synthesize({ ...request(), text: "😀".repeat(4097) })).rejects.toThrow(
        "4096",
      );
      expect(requests).toHaveLength(0);
      await provider.synthesize({ ...request(), text: "😀".repeat(4096) });
      expect(requests[0]?.body.input).toBe("😀".repeat(4096));
    });
  });
});

function selectGradium(fixture: Fixture) {
  Object.assign(fixture.catalog, {
    providerId: "gradium",
    model: null,
    requestFormat: "gradium.speech",
    responseFormat: "audio.binary",
    routeKind: "native",
  });
  return {
    ...fixture.cfg,
    agents: { defaults: {} },
    tts: {
      provider: "clawrouter",
      providers: { clawrouter: { upstreamProvider: "gradium", voiceId: "synthetic-voice" } },
    },
  } satisfies OpenClawConfig;
}

const GRADIUM_WAV = Buffer.from(
  "UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "base64",
);
// Published PR454 synthetic transport fixture; not decoder/playback or live inference proof.
const GRADIUM_OPUS = Buffer.from("OggS\0synthetic OpusHead transport fixture", "utf8");
function respondGradium(res: ServerResponse, request: Request) {
  const body = (request.body.body ?? request.body) as Record<string, unknown>;
  res.setHeader("content-type", body.output_format === "opus" ? "audio/ogg" : "audio/wav");
  res.end(body.output_format === "wav" ? GRADIUM_WAV : GRADIUM_OPUS);
}

describe("ClawRouter native Gradium speech", () => {
  it("returns native voice-note bytes but denies unqualified proxy telephony", async () => {
    await withFixture(async (fixture) => {
      const cfg = selectGradium(fixture);
      expect(
        await speech(cfg).synthesize({
          ...fixture.request(cfg.tts.providers.clawrouter),
          cfg,
          target: "voice-note",
        }),
      ).toMatchObject({
        outputFormat: "opus",
        voiceCompatible: true,
        audioBuffer: GRADIUM_OPUS,
      });
      expect(
        await textToSpeechTelephony({
          text: "Synthetic phone speech",
          cfg,
          prefsPath: fixture.home + "/tts-prefs.json",
        }),
      ).toMatchObject({
        success: false,
        error: expect.stringContaining("telephony output is not qualified"),
      });
      expect(fixture.requests.map((request) => request.body.output_format)).toEqual(["opus"]);
      expect(
        fixture.requests.every(
          (request) => request.auth === "Bearer fixture-router" && !request.vendorKey,
        ),
      ).toBe(true);
    }, respondGradium);
  });

  it.each(["native", "manifest"] as const)(
    "runs model-less %s offers through actual TTS",
    async (routeKind) => {
      await withFixture(async (fixture) => {
        const cfg = selectGradium(fixture);
        fixture.catalog.routeKind = routeKind;
        const result = await fixture.tts({ cfg });
        expect(result).toMatchObject({
          success: true,
          audioBuffer: GRADIUM_WAV,
          outputFormat: "wav",
        });
        expect(fixture.catalogRequests).toEqual(["Bearer fixture-router"]);
        expect(fixture.requests).toEqual([
          {
            url:
              routeKind === "native"
                ? "/v1/native/gradium/api/post/speech/tts"
                : "/v1/proxy/gradium/speech",
            auth: "Bearer fixture-router",
            vendorKey: undefined,
            body:
              routeKind === "manifest"
                ? {
                    body: {
                      text: "Hello from ClawRouter",
                      voice_id: "synthetic-voice",
                      only_audio: true,
                      output_format: "wav",
                      json_config: '{"padding_bonus":0}',
                    },
                  }
                : {
                    text: "Hello from ClawRouter",
                    voice_id: "synthetic-voice",
                    only_audio: true,
                    output_format: "wav",
                    json_config: '{"padding_bonus":0}',
                  },
          },
        ]);
      }, respondGradium);
    },
  );

  it.each([
    { observedAt: "2000-01-01T00:00:00Z" },
    { authType: "access" },
    { eligible: false },
    { providerId: "openai" as const },
    { model: "unqualified" },
    { requestFormat: "unknown.speech" },
    { route: "https://foreign.example/speech" },
    { path: "/foreign/speech" },
  ])("denies stale or foreign catalog offers through TTS (%j)", async (patch) => {
    await withFixture(async (fixture) => {
      const cfg = selectGradium(fixture);
      Object.assign(fixture.catalog, patch);
      expect((await fixture.tts({ cfg })).success).toBe(false);
      expect(fixture.requests).toHaveLength(0);
    }, respondGradium);
  });

  it("never substitutes the native Gradium key for a missing proxy key", async () => {
    await withFixture(async (fixture) => {
      const cfg = withoutKey(selectGradium(fixture));
      expect((await fixture.tts({ cfg })).success).toBe(false);
      expect(fixture.catalogRequests).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    }, respondGradium);
  });

  it("rejects mismatched audio MIME through the real consumer", async () => {
    await withFixture(async (fixture) => {
      expect((await fixture.tts({ cfg: selectGradium(fixture) })).success).toBe(false);
      expect(fixture.requests).toHaveLength(1);
    });
  });

  it.each([
    "partial-status",
    "truncated",
    "oversized",
    "redirect",
    "range",
    "mime-parameters",
    "encoding",
  ] as const)("rejects %s binary delivery through TTS", async (failure) => {
    await withFixture(
      async (fixture) => {
        const cfg = selectGradium(fixture);
        expect((await fixture.tts({ cfg })).success).toBe(false);
        expect(fixture.requests).toHaveLength(1);
      },
      (res) => {
        res.setHeader("content-type", "audio/wav");
        if (failure === "partial-status") {
          res.statusCode = 206;
        }
        if (failure === "range") {
          res.setHeader("content-range", "bytes 0-15/100");
        }
        if (failure === "mime-parameters") {
          res.setHeader("content-type", "audio/wav; codecs=unknown");
        }
        if (failure === "encoding") {
          res.setHeader("content-encoding", "gzip");
        }
        if (failure === "truncated") {
          res.setHeader("content-length", GRADIUM_WAV.length + 1);
          res.setHeader("connection", "close");
        }
        if (failure === "oversized") {
          res.setHeader("content-length", 16 * 1024 * 1024 + 1);
        }
        if (failure === "redirect") {
          res.statusCode = 307;
          res.setHeader("location", "/replayed-speech");
        }
        res.end(GRADIUM_WAV);
      },
    );
  });

  it.each([{ model: "gradium/fake-model" }, { speed: 1.2 }, { instructions: "whisper" }])(
    "rejects unsupported native settings before submission (%j)",
    async (override) => {
      await withFixture(async (fixture) => {
        const cfg = selectGradium(fixture);
        Object.assign(cfg.tts.providers.clawrouter, override);
        expect((await fixture.tts({ cfg })).success).toBe(false);
        expect(fixture.requests).toHaveLength(0);
      }, respondGradium);
    },
  );
});
