import assert from "node:assert/strict";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig, SecretInput } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import plugin from "../index.js";
import { listedModel, streamModel } from "./stream.test-support.js";

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
      const requests: Array<[string | undefined, string | undefined, unknown]> = [];
      const expectedKey = kind === "runtime" ? "synthetic-runtime-key" : "synthetic-store-key";
      const authorization = `Bearer ${expectedKey}`;
      const headers = kind === "header" ? { Authorization: authorization } : undefined;
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8").on("data", (chunk: string) => {
            body += chunk;
          });
          request.once("end", () => {
            requests.push([
              request.url,
              request.headers.authorization,
              body ? JSON.parse(body) : undefined,
            ]);
            const json = (value: unknown) =>
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(value));
            if (request.headers.authorization !== authorization) {
              response.writeHead(401).end();
            } else if (request.url === "/api/v1/models") {
              json(listedModel("qwen3.5-0.8b", 262144));
            } else if (request.url === "/api/v1/models/load") {
              json({ status: "loaded", instance_id: "prepared-large" });
            } else {
              response
                .writeHead(200, { "content-type": "text/event-stream" })
                .end(
                  'data: {"choices":[{"index":0,"delta":{"content":"Authenticated."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                );
            }
          });
        },
        async (origin) => {
          const configFor = (apiKey: SecretInput | undefined): OpenClawConfig =>
            createModelProviderConfig({
              lmstudio: {
                baseUrl: `${origin}/v1`,
                api: "openai-completions",
                apiKey,
                models: [],
                headers,
              },
            });
          const runtime = configFor("synthetic-store-key");
          const config = kind === "header" ? configFor("lmstudio-local") : runtime;
          if (kind !== "header") {
            setRuntimeConfigSnapshot(
              runtime,
              configFor({ source: "store", provider: "default", id: "LMSTUDIO_API_KEY" }),
            );
          }
          let apiKey: string | undefined = kind === "header" ? "lmstudio-local" : expectedKey;
          if (kind === "store") {
            const resolved = await resolveApiKeyForProvider({
              provider: "lmstudio",
              cfg: config,
              secretSentinels: true,
            });
            apiKey = resolved.apiKey;
          }
          const provider = capturePluginRegistration(plugin).providers[0];
          assert(provider?.wrapStreamFn, "LM Studio stream wrapper was not registered");
          const model = streamModel(`${origin}/v1`, { headers });
          const wrapped = provider.wrapStreamFn({
            provider: "lmstudio",
            modelId: model.id,
            config,
          });
          assert(wrapped, "LM Studio stream wrapper was not created");
          const events = [];
          for await (const event of await wrapped(
            model,
            { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
            { apiKey },
          )) {
            events.push(event);
          }
          expect(requests).toEqual([
            ["/api/v1/models", authorization, undefined],
            [
              "/api/v1/models/load",
              authorization,
              { model: "qwen3.5-0.8b", context_length: 16384 },
            ],
            [
              "/v1/chat/completions",
              authorization,
              expect.objectContaining({ model: "prepared-large" }),
            ],
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
