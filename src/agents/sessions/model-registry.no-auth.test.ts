import OpenAI from "openai";
import { afterEach, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../model-auth-markers.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createRegistry(params: {
  providerApi?: "openai-completions" | "openai-responses";
  modelApi?: "openai-completions" | "openai-responses";
  auth?: "none";
  storedKey?: boolean;
  inlineKey?: boolean;
  authorization?: string;
}) {
  const authStorage = AuthStorage.inMemory(
    params.storedKey ? { custom: { type: "api_key", key: "synthetic-stored-key" } } : {},
  );
  const getApiKey = vi.spyOn(authStorage, "getApiKey");
  const registry = ModelRegistry.fromCapturedSources(authStorage, "/unused/models.json", {
    pluginCatalogs: [],
    includePluginCatalogs: false,
    modelsJsonContents: JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://inference.example.invalid/v1",
          api: params.providerApi ?? "openai-completions",
          auth: params.auth,
          ...(params.inlineKey === false ? {} : { apiKey: "synthetic-inline-key" }),
          authHeader: true,
          headers: {
            Authorization: params.authorization ?? "Bearer synthetic-provider-header",
            "X-Provider": "visible-provider-header",
          },
          models: [
            {
              id: "model",
              api: params.modelApi ?? "openai-completions",
              headers: {
                authorization: params.authorization ?? "Bearer synthetic-model-header",
                "X-Model": "visible-model-header",
              },
            },
          ],
        },
      },
    }),
  });
  const model = registry.find("custom", "model");
  if (!model) {
    throw new Error(registry.getError() ?? "Expected custom model");
  }
  return { registry, model, getApiKey };
}

it.each(["openai-completions", "openai-responses"] as const)(
  "keeps registry no-auth terminal with provider adapter %s and an effective Completions route",
  async (providerApi) => {
    const { registry, model, getApiKey } = createRegistry({
      providerApi,
      auth: "none",
      storedKey: true,
    });
    const requestModel = {
      ...model,
      headers: {
        Authorization: "Bearer synthetic-runtime-header",
        authorization: "Bearer synthetic-runtime-lowercase-header",
        "X-Runtime": "visible-runtime-header",
      },
    };
    const auth = await registry.getApiKeyAndHeaders(requestModel);
    expect(auth.ok).toBe(true);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(getApiKey).not.toHaveBeenCalled();
    let sentHeaders: Headers | undefined;
    const client = new OpenAI({
      apiKey: auth.apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: { ...requestModel.headers, ...auth.headers },
      maxRetries: 0,
      fetch: async (_url, init) => {
        sentHeaders = new Headers(init?.headers);
        return Response.json({ id: "synthetic-completion", choices: [] });
      },
    });
    await client.chat.completions.create({ model: model.id, messages: [] });
    expect(sentHeaders?.has("authorization")).toBe(false);
    expect(sentHeaders?.get("x-provider")).toBe("visible-provider-header");
    expect(sentHeaders?.get("x-model")).toBe("visible-model-header");
    expect(sentHeaders?.get("x-runtime")).toBe("visible-runtime-header");
  },
);

it("does not resolve unused Authorization values for no-auth registry requests", async () => {
  vi.stubEnv("OPENCLAW_TEST_UNUSED_AUTHORIZATION", "");
  const { registry, model, getApiKey } = createRegistry({
    auth: "none",
    inlineKey: false,
    authorization: "OPENCLAW_TEST_UNUSED_AUTHORIZATION",
  });
  expect(registry.getAvailable()).toContain(model);
  await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
    ok: true,
    apiKey: CUSTOM_LOCAL_AUTH_MARKER,
    headers: { Authorization: null },
  });
  expect(getApiKey).not.toHaveBeenCalled();
});

it("rejects an effective Responses override before registry credential lookup", async () => {
  const { registry, model, getApiKey } = createRegistry({
    modelApi: "openai-responses",
    auth: "none",
    storedKey: true,
  });
  expect(registry.getAvailable()).not.toContain(model);
  await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
    ok: false,
    error:
      'Provider "custom" with auth: "none" requires the openai-completions adapter. Select that adapter or configure an API key.',
  });
  expect(getApiKey).not.toHaveBeenCalled();
});

it("preserves normal registry credential precedence and bearer headers", async () => {
  const { registry, model } = createRegistry({
    storedKey: true,
  });
  await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
    ok: true,
    apiKey: "synthetic-stored-key",
    headers: { Authorization: "Bearer synthetic-stored-key" },
  });
});
