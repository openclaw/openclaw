import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";

type Capture = { url: string; authorization?: string; body: Buffer; form: FormData };
export type AudioCatalog = {
  provider: string;
  model: string;
  eligible: boolean;
  observedAt?: string;
  requestFormat: string;
  responseFormat: string;
  route?: string;
  path?: string;
  authType?: string;
  upstream?: string;
};
export async function withClawRouterAudioFixture(
  run: (p: {
    cfg: OpenClawConfig;
    filePath: string;
    requests: Capture[];
    arrivals: string[];
    audio: Buffer;
    home: string;
    catalog: AudioCatalog;
    catalogRequests: string[];
  }) => Promise<void>,
  respond: (res: ServerResponse) => void = (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "synthetic transcript" }));
  },
  respondCatalog?: (res: ServerResponse) => void,
) {
  await withTempHome(
    async (home) => {
      const audio = Buffer.alloc(2048, 42);
      audio.write("RIFF", 0);
      audio.writeUInt32LE(2040, 4);
      audio.write("WAVEfmt ", 8);
      audio.writeUInt32LE(16, 16);
      audio.writeUInt16LE(1, 20);
      audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(8000, 24);
      audio.writeUInt32LE(16000, 28);
      audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34);
      audio.write("data", 36);
      audio.writeUInt32LE(2004, 40);
      const filePath = home + "/meeting (1).wav";
      await fs.writeFile(filePath, audio);
      const requests: Capture[] = [];
      const arrivals: string[] = [];
      const catalogRequests: string[] = [];
      const catalog: AudioCatalog = {
        provider: "openai",
        model: "gpt-4o-transcribe",
        eligible: true,
        requestFormat: "openai.audio_transcriptions",
        responseFormat: "openai.audio_transcriptions",
      };
      await withServer(
        (req, res) => {
          void (async () => {
            if (req.url === "/v1/catalog") {
              catalogRequests.push(req.headers.authorization ?? "");
              if (respondCatalog) {
                respondCatalog(res);
                return;
              }
              const path = catalog.path ?? "/v1/audio/transcriptions";
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
                      id: catalog.provider,
                      allowed: true,
                      executable: true,
                      nativeBaseUrl: `/v1/native/${catalog.provider}`,
                      routes: [
                        {
                          endpoint: "transcriptions",
                          path,
                          methods: ["POST"],
                          requestFormat: catalog.requestFormat,
                          responseFormat: catalog.responseFormat,
                        },
                      ],
                      models: [
                        {
                          id: `${catalog.provider}/${catalog.model}`,
                          upstream: catalog.upstream ?? catalog.model,
                          capabilities: ["audio.transcription"],
                        },
                      ],
                      offers: [
                        {
                          endpoint: "transcriptions",
                          modelId: `${catalog.provider}/${catalog.model}`,
                          transport: "http",
                          routeKind: "native",
                          route: catalog.route ?? `/v1/native/${catalog.provider}${path}`,
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
            arrivals.push(`${req.method} ${req.url}`);
            const body = await consumeBuffer(req);
            const form = await new Response(body, {
              headers: { "content-type": req.headers["content-type"] ?? "" },
            }).formData();
            requests.push({
              url: req.url ?? "",
              authorization: req.headers.authorization,
              body,
              form,
            });
            respond(res);
          })().catch((error: unknown) =>
            res.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        },
        async (baseUrl) => {
          const cfg: OpenClawConfig = {
            plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
            models: {
              providers: {
                clawrouter: {
                  baseUrl,
                  apiKey: "fixture-router",
                  request: { allowPrivateNetwork: true },
                  models: [],
                },
              },
            },
            tools: {
              media: {
                models: [{ provider: "clawrouter", capabilities: ["audio"] }],
                audio: { enabled: true },
              },
            },
          };
          await run({ cfg, filePath, requests, arrivals, audio, home, catalog, catalogRequests });
        },
      );
    },
    {
      env: {
        CLAWROUTER_API_KEY: undefined,
        OPENAI_API_KEY: "fixture-upstream-never-router",
        SENSEAUDIO_API_KEY: "fixture-senseaudio-never-router",
      },
    },
  );
}

export const respondPricingRequired = (res: ServerResponse) => {
  res.statusCode = 400;
  res.end(
    JSON.stringify({
      error: {
        code: "pricing_required",
        message: "No qualified arbitrary-file reserve bound",
      },
    }),
  );
};
