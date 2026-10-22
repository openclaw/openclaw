import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig, SecretInput } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each(["store", "runtime", "header"] as const)(
  "authenticates native preload and inference with %s credentials",
  async (kind) => {
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    await withTempHome(async () => {
      const requests: Array<{ path: string; authorization?: string; body: unknown }> = [];
      const expectedKey = kind === "runtime" ? "synthetic-runtime-key" : "synthetic-store-key";
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
          request.once("end", () => {
            requests.push({
              path: request.url ?? "",
              authorization: request.headers.authorization,
              body: body ? JSON.parse(body) : undefined,
            });
            if (request.headers.authorization !== `Bearer ${expectedKey}`) {
              response.writeHead(401).end();
            } else if (request.url === "/api/v1/models") {
              response.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  models: [
                    {
                      type: "llm",
                      key: "test-model",
                      max_context_length: 64000,
                      loaded_instances: [{ id: "jit-small", config: { context_length: 8192 } }],
                    },
                  ],
                }),
              );
            } else if (request.url === "/api/v1/models/load") {
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ status: "loaded", instance_id: "prepared-large" }));
            } else {
              response.writeHead(200, { "content-type": "text/event-stream" }).end(
                `data: ${JSON.stringify({
                  id: "test-completion",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "prepared-large",
                  choices: [
                    { index: 0, delta: { content: "Authenticated." }, finish_reason: "stop" },
                  ],
                })}\n\ndata: [DONE]\n\n`,
              );
            }
          });
        },
        async (origin) => {
          const configFor = (apiKey: SecretInput | undefined): OpenClawConfig => ({
            models: {
              providers: {
                lmstudio: {
                  baseUrl: `${origin}/v1`,
                  api: "openai-completions",
                  apiKey,
                  models: [],
                  ...(kind === "header"
                    ? { headers: { Authorization: `Bearer ${expectedKey}` } }
                    : {}),
                },
              },
            },
          });
          const source = configFor({
            source: "store",
            provider: "default",
            id: "LMSTUDIO_API_KEY",
          });
          const runtime = configFor("synthetic-store-key");
          const config = kind === "header" ? configFor("lmstudio-local") : runtime;
          if (kind !== "header") {
            setRuntimeConfigSnapshot(runtime, source);
          }
          const apiKey =
            kind === "header"
              ? "lmstudio-local"
              : kind === "runtime"
                ? expectedKey
                : (
                    await resolveApiKeyForProvider({
                      provider: "lmstudio",
                      cfg: config,
                      secretSentinels: true,
                    })
                  ).apiKey;
          const provider = capturePluginRegistration(plugin).providers[0];
          if (!provider?.wrapStreamFn) {
            throw new Error("LM Studio stream wrapper was not registered");
          }
          const model: Parameters<StreamFn>[0] = {
            id: "test-model",
            name: "Test model",
            provider: "lmstudio",
            api: "openai-completions",
            baseUrl: `${origin}/v1`,
            contextWindow: 64000,
            contextTokens: 64000,
            maxTokens: 128,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(kind === "header" ? { headers: { Authorization: `Bearer ${expectedKey}` } } : {}),
          };
          const wrapped = provider.wrapStreamFn({
            provider: "lmstudio",
            modelId: model.id,
            config,
          });
          if (!wrapped) {
            throw new Error("LM Studio stream wrapper was not created");
          }
          const events = [];
          for await (const event of await wrapped(
            model,
            { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
            { apiKey },
          )) {
            events.push(event);
          }
          expect(requests).toEqual([
            { path: "/api/v1/models", authorization: `Bearer ${expectedKey}`, body: undefined },
            {
              path: "/api/v1/models/load",
              authorization: `Bearer ${expectedKey}`,
              body: { model: "test-model", context_length: 64000 },
            },
            expect.objectContaining({
              path: "/v1/chat/completions",
              authorization: `Bearer ${expectedKey}`,
              body: expect.objectContaining({ model: "prepared-large" }),
            }),
          ]);
          expect(events.at(-1)).toMatchObject({
            type: "done",
            message: { content: [{ type: "text", text: "Authenticated." }] },
          });
        },
      );
    });
  },
);
