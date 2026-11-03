import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { upsertAuthProfileAsync, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { getSpeechProvider, type SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech, textToSpeechTelephony } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";

const AUDIO = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
type Request = { url: string; auth?: string; body: Record<string, unknown> };
type Catalog = {
  model: string;
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
      const catalogRequests: string[] = [];
      const catalog: Catalog = {
        model: "tts-1",
        routeKind: "unified",
        eligible: true,
        requestFormat: "openai.audio_speech",
        responseFormat: "audio.binary",
      };
      await withServer(
        (req, res) => {
          void (async () => {
            if (req.url === "/v1/catalog") {
              catalogRequests.push(req.headers.authorization ?? "");
              const route =
                catalog.route ??
                (catalog.routeKind === "unified"
                  ? "/v1/audio/speech"
                  : catalog.routeKind === "native"
                    ? "/v1/native/openai/v1/audio/speech"
                    : "/v1/proxy/openai/speech");
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  version: "clawrouter.client-catalog.v1",
                  providers: [
                    {
                      id: "openai",
                      allowed: true,
                      executable: true,
                      nativeBaseUrl: "/v1/native/openai",
                      routes: [
                        {
                          endpoint: "speech",
                          path: "/v1/audio/speech",
                          methods: ["POST"],
                          requestFormat: catalog.requestFormat,
                          responseFormat: catalog.responseFormat,
                        },
                      ],
                      models: [
                        {
                          id: "openai/" + catalog.model,
                          upstream: catalog.model,
                          capabilities: ["audio.speech"],
                        },
                      ],
                      offers: [
                        {
                          endpoint: "speech",
                          modelId: "openai/" + catalog.model,
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
    { env: { CLAWROUTER_API_KEY: routerApiKey, OPENAI_API_KEY: "fixture-openai-not-router" } },
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
        await expect(provider.synthesize({ ...request(), cfg: storedCfg })).resolves.toMatchObject({
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

  it("aborts an in-flight HTTP body at the request deadline and releases its socket", async () => {
    const closed = createDeferred();
    await withFixture(
      async ({ cfg, request, requests }) => {
        await expect(speech(cfg).synthesize({ ...request(), timeoutMs: 250 })).rejects.toThrow(
          /timed out|abort/i,
        );
        expect(requests).toHaveLength(1);
        await closed.promise;
      },
      (res) => {
        res.setHeader("content-type", "audio/mpeg");
        res.write(AUDIO.subarray(0, 1));
        res.once("close", () => closed.resolve());
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
