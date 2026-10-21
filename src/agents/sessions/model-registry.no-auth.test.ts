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
    params.storedKey ? { custom: { type: "api_key", key: "stored-key" } } : {},
  );
  const getApiKey = vi.spyOn(authStorage, "getApiKey");
  const modelConfig = {
    id: "model",
    api: params.modelApi ?? "openai-completions",
    headers: { authorization: params.authorization ?? "Bearer model", "X-Model": "model" },
  };
  const provider = {
    baseUrl: "https://inference.example.invalid/v1",
    api: params.providerApi ?? "openai-completions",
    auth: params.auth,
    ...(params.inlineKey === false ? {} : { apiKey: "inline-key" }),
    authHeader: true,
    headers: { Authorization: params.authorization ?? "Bearer provider", "X-Provider": "provider" },
    models: [modelConfig],
  };
  const registry = ModelRegistry.fromCapturedSources(authStorage, "/unused/models.json", {
    pluginCatalogs: [],
    includePluginCatalogs: false,
    modelsJsonContents: JSON.stringify({ providers: { custom: provider } }),
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
        Authorization: "Bearer upper-runtime",
        authorization: "Bearer lower-runtime",
        "X-Runtime": "runtime",
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
    expect(Object.fromEntries(sentHeaders ?? [])).toMatchObject({
      "x-provider": "provider",
      "x-model": "model",
      "x-runtime": "runtime",
    });
  },
);

it.each([true, false])(
  "resolves registry credentials and headers with auth:none=%s",
  async (noAuth) => {
    vi.stubEnv("OPENCLAW_TEST_UNUSED_AUTHORIZATION", "");
    const { registry, model, getApiKey } = createRegistry({
      auth: noAuth ? "none" : undefined,
      inlineKey: !noAuth,
      storedKey: !noAuth,
      authorization: noAuth ? "OPENCLAW_TEST_UNUSED_AUTHORIZATION" : undefined,
    });
    expect(registry.getAvailable()).toContain(model);
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      ok: true,
      apiKey: noAuth ? CUSTOM_LOCAL_AUTH_MARKER : "stored-key",
      headers: { Authorization: noAuth ? null : "Bearer stored-key" },
    });
    if (noAuth) {
      expect(getApiKey).not.toHaveBeenCalled();
    }
  },
);

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
