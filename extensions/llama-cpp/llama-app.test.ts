import type { IncomingMessage, ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";

const modelId = "ggml-org/fixture:Q4_K_M";
afterEach(() => vi.unstubAllEnvs());
function providers() {
  const registration = createCapturedPluginRegistration({ id: "llama-cpp" });
  plugin.register(registration.api);
  return registration.providers;
}
function appProvider(): ProviderPlugin {
  return expectDefined(
    providers().find(({ id }) => id === "llama-app"),
    "registered Llama provider",
  );
}
function withApp(
  reply: (request: IncomingMessage, response: ServerResponse) => unknown,
  run: (baseUrl: string) => Promise<void>,
) {
  return withServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply(request, response)));
  }, run);
}
function catalog(provider: ProviderPlugin, config: OpenClawConfig, key?: string) {
  return expectDefined(provider.catalog, "catalog").run({
    config,
    env: { LLAMA_APP_TEST_HEADER: "Bearer app-header" },
    resolveProviderApiKey: (id) => {
      expect(id).toBe("llama-app");
      return { apiKey: key };
    },
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
}
const props = {
  default_generation_settings: { n_ctx: 24576, params: { n_predict: 2048 } },
  modalities: { vision: true },
  chat_template_caps: { supports_tool_calls: true, supports_typed_content: true },
};

it.each([{ providerIds: [] }, { providerIds: ["llama-cpp"] }])(
  "skips credential acquisition for the unselected app catalog $providerIds",
  async ({ providerIds }) => {
    const unexpected = vi.fn((): never => {
      throw new Error("Unselected provider acquired credentials");
    });
    await expect(
      expectDefined(appProvider().catalog, "catalog").run({
        config: {},
        env: {},
        providerIds,
        resolveProviderApiKey: unexpected,
        resolveProviderAuth: unexpected,
      }),
    ).resolves.toBeNull();
    expect(unexpected).not.toHaveBeenCalled();
  },
);

it("discovers Llama beside managed llama.cpp without changing its ownership or defaults", async () => {
  const app = appProvider();
  const requests: string[] = [];
  await withApp(
    (request) => {
      requests.push(request.method + " " + request.url);
      expect(request.headers.authorization).toBe("Bearer app-header");
      if (request.url === "/models") {
        return {
          data: [
            { id: modelId, status: { value: "sleeping" } },
            { id: "unloaded/model", status: { value: "unloaded" } },
          ],
        };
      }
      return request.url?.startsWith("/props") ? props : {};
    },
    async (baseUrl) => {
      const managed = {
        baseUrl: "http://127.0.0.1:19432/v1",
        models: [],
        localService: { command: "/managed/llama-server" },
      };
      const config: OpenClawConfig = {
        agents: { defaults: { model: { primary: "llama-cpp/installed" } } },
        models: {
          providers: {
            "llama-cpp": managed,
            "llama-app": {
              baseUrl,
              models: [],
              headers: {
                Authorization: { source: "env", provider: "default", id: "LLAMA_APP_TEST_HEADER" },
              },
            },
          },
        },
      };
      const before = JSON.stringify(config);
      const result = await catalog(app, config, "llama-app-local");
      expect(result).toMatchObject({
        provider: {
          baseUrl: baseUrl + "/v1",
          models: [
            {
              id: modelId,
              contextWindow: 24576,
              maxTokens: 2048,
              input: ["text", "image"],
              compat: { supportsTools: true, requiresStringContent: false },
            },
            { id: "unloaded/model" },
          ],
        },
      });
      expect(JSON.stringify(config)).toBe(before);
      expect(requests).toEqual([
        "GET /health",
        "GET /models",
        "GET /props?model=ggml-org%2Ffixture%3AQ4_K_M&autoload=false",
      ]);
    },
  );
});

it("resolves Llama runtime SecretRefs without reading llama.cpp credentials and honors explicit private-network denial", async () => {
  vi.stubEnv("LLAMA_APP_TEST_KEY", "app-key");
  const app = appProvider();
  const seen: Array<string | undefined> = [];
  await withApp(
    (request) => {
      seen.push(request.headers.authorization);
      return request.url === "/models"
        ? { data: [{ id: modelId, status: { value: "loaded" } }] }
        : request.url?.startsWith("/props")
          ? props
          : {};
    },
    async (baseUrl) => {
      const appConfig = {
        baseUrl,
        models: [],
        apiKey: { source: "env" as const, provider: "default", id: "LLAMA_APP_TEST_KEY" },
      };
      const config: OpenClawConfig = {
        models: {
          providers: {
            "llama-cpp": {
              baseUrl: "http://127.0.0.1:8080",
              models: [],
              apiKey: "wrong-namespace",
            },
            "llama-app": appConfig,
          },
        },
      };
      const prepare = expectDefined(app.prepareDynamicModel, "dynamic model hook");
      const model = await prepare({
        config,
        provider: "llama-app",
        modelId,
        modelRegistry: {} as never,
        providerConfig: appConfig,
      });
      expect(model).toMatchObject({
        provider: "llama-app",
        id: modelId,
        baseUrl: baseUrl + "/v1",
        contextWindow: 24576,
      });
      expect(seen).toEqual(["Bearer app-key", "Bearer app-key", "Bearer app-key"]);
      const denied = { ...appConfig, request: { allowPrivateNetwork: false } };
      await expect(
        catalog(app, { models: { providers: { "llama-app": denied } } }, "app-key"),
      ).resolves.toMatchObject({ outcomes: [{ provider: "llama-app", status: "unavailable" }] });
      expect(seen).toHaveLength(3);
    },
  );
});

it.each(["llama-app-local", "endpoint-key"])(
  "streams serialized Llama requests with %s through the registered transport",
  async (apiKey) => {
    const app = appProvider();
    const bodies: unknown[] = [];
    await withServer(
      (request, response) => {
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.headers.authorization).toBe("Bearer " + apiKey);
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          bodies.push(JSON.parse(body));
          response.setHeader("Content-Type", "text/event-stream");
          response.end(
            'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        });
      },
      async (baseUrl) => {
        const model: Model<"openai-completions"> = {
          id: modelId,
          name: "Fixture",
          provider: "llama-app",
          api: "openai-completions",
          baseUrl: baseUrl + "/v1",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 24576,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsJsonSchemaResponseFormat: true,
          },
        };
        const schema = { type: "object", properties: { ok: { type: "boolean" } } };
        const wrapped = expectDefined(
          app.wrapStreamFn?.({
            provider: "llama-app",
            modelId,
            model,
            streamFn: streamSimple,
            thinkingLevel: "off",
          }),
          "stream wrapper",
        );
        const result = await (
          await wrapped(
            model,
            { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
            { apiKey, responseFormat: schema, maxTokens: 8 },
          )
        ).result();
        expect(result.stopReason).toBe("stop");
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
        expect(bodies).toEqual([
          expect.objectContaining({
            model: modelId,
            stream: true,
            response_format: { type: "json_object", schema },
            chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
          }),
        ]);
      },
    );
  },
);
