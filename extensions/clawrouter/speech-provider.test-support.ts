import type { ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSpeechProvider, type SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { expect } from "vitest";
export const AUDIO = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
export type Request = {
  url: string;
  auth?: string;
  vendorKey?: string;
  body: Record<string, unknown>;
  ssml?: string;
  contentType?: string;
  outputFormat?: string;
};
type Catalog = {
  providerId: "openai" | "gradium" | "azure-speech" | "elevenlabs";
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
export type Fixture = {
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
export const withoutKey = (cfg: OpenClawConfig): OpenClawConfig => ({
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

export async function withFixture(
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
        providerId: "openai",
        model: "tts-1",
        routeKind: "unified",
        eligible: true,
        requestFormat: "openai.audio_speech",
        responseFormat: "audio.binary",
      };
      await withServer(
        (req, res) => {
          void (async () => {
            expect(req.headers["xi-api-key"]).toBeUndefined();
            if (catalog.providerId === "azure-speech") {
              expect(req.headers["ocp-apim-subscription-key"]).toBeUndefined();
              expect(req.headers["ocp-apim-subscription-region"]).toBeUndefined();
              expect(req.headers["x-api-key"]).toBeUndefined();
            }
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
              body: catalog.providerId === "azure-speech" ? {} : text ? JSON.parse(text) : {},
              ...(catalog.providerId === "azure-speech"
                ? {
                    ssml: text,
                    contentType: req.headers["content-type"],
                    outputFormat: req.headers["x-microsoft-outputformat"] as string | undefined,
                  }
                : {}),
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
    {
      env: {
        CLAWROUTER_API_KEY: routerApiKey,
        OPENAI_API_KEY: "fixture-openai-not-router",
        GRADIUM_API_KEY: "fixture-gradium-not-router",
        ELEVENLABS_API_KEY: "fixture-elevenlabs-not-router",
        AZURE_SPEECH_API_KEY: "fixture-azure-not-router",
        AZURE_SPEECH_REGION: "westus",
      },
    },
  );
}

export function speech(cfg: OpenClawConfig) {
  return getSpeechProvider("clawrouter", cfg)!;
}
