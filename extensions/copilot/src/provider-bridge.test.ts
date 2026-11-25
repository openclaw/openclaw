import { describe, expect, it } from "vitest";
import { resolveCopilotProvider, supportsCopilotByokProviderShape } from "./provider-bridge.js";

type Input = Parameters<typeof resolveCopilotProvider>[0];
const baseUrl = "https://proxy.example/v1";
const expectedProvider = {
  type: "openai",
  wireApi: "responses",
  baseUrl,
  modelId: "proxy-model",
  wireModel: "proxy-model",
};
function resolveModel(model: Partial<Input["model"]> = {}, auth: Omit<Input, "model"> = {}) {
  return resolveCopilotProvider({
    model: {
      provider: "custom-proxy",
      api: "openai-responses",
      id: "proxy-model",
      baseUrl,
      ...model,
    },
    ...auth,
  });
}
const azureModel = {
  provider: "custom-azure",
  api: "azure-openai-responses",
  id: "deployment-gpt",
  baseUrl: "https://example.openai.azure.com/openai/v1",
} satisfies Partial<Input["model"]>;
const azureExpected = {
  type: "azure",
  wireApi: "responses",
  modelId: "deployment-gpt",
  wireModel: "deployment-gpt",
};

describe("resolveCopilotProvider", () => {
  it("keeps the subscription provider on the native Copilot auth path", () => {
    expect(
      resolveModel(
        {
          provider: "github-copilot",
          api: "github-copilot",
          id: "gpt-5",
          baseUrl: "https://ignored.example",
        },
        { resolvedApiKey: "ignored" },
      ),
    ).toEqual({ mode: "github-copilot" });
  });

  it("maps OpenAI Responses BYOK with a bearer token and stable limits", () => {
    const result = resolveModel(
      {
        provider: "local-proxy",
        authHeader: true,
        contextTokens: 12_000,
        maxTokens: 512,
        headers: { "X-Trace": "test" },
      },
      { resolvedApiKey: "secret-key", authProfileId: "local-proxy:main" },
    );
    expect(result).toEqual({
      mode: "byok",
      authProfileId: "local-proxy:main",
      authProfileVersion: expect.stringMatching(/^sha256:/),
      provider: {
        ...expectedProvider,
        bearerToken: "secret-key",
        headers: { "X-Trace": "test" },
        maxPromptTokens: 12_000,
        maxOutputTokens: 512,
      },
    });
  });

  it("defaults custom BYOK providers without an api to OpenAI Responses", () => {
    expect(
      resolveModel({ api: undefined }, { resolvedApiKey: "secret-key" }).provider,
    ).toMatchObject({ type: "openai", wireApi: "responses", baseUrl });
    expect(supportsCopilotByokProviderShape({ baseUrl })).toBe(true);
  });

  it("maps OpenAI Chat Completions BYOK bearer auth with the provider-local model id", () => {
    expect(
      resolveModel(
        {
          provider: "tencent-tokenplan",
          api: "openai-completions",
          id: "hy3",
          baseUrl: "https://tokenplan.example/v1",
          authHeader: true,
        },
        { resolvedApiKey: "secret-key" },
      ).provider,
    ).toMatchObject({
      type: "openai",
      wireApi: "completions",
      baseUrl: "https://tokenplan.example/v1",
      modelId: "hy3",
      wireModel: "hy3",
      bearerToken: "secret-key",
    });
  });

  it("changes the BYOK compatibility fingerprint when token limits change", () => {
    const version = (contextTokens: number, maxTokens: number) =>
      resolveModel({ contextTokens, maxTokens }, { resolvedApiKey: "secret-key" })
        .authProfileVersion;
    expect(version(8_000, 512)).not.toBe(version(16_000, 1024));
  });

  it("maps Anthropic and Ollama-compatible APIs", () => {
    expect(
      resolveModel({
        provider: "anthropic-proxy",
        api: "anthropic-messages",
        id: "claude",
        baseUrl: "https://anthropic.example",
      }).provider,
    ).toMatchObject({ type: "anthropic", baseUrl: "https://anthropic.example" });
    expect(
      resolveModel({
        provider: "ollama-compatible",
        api: "ollama",
        id: "qwen",
        baseUrl: "https://ollama-compatible.example/v1",
      }).provider,
    ).toMatchObject({ type: "openai", wireApi: "completions" });
  });

  it("normalizes Azure OpenAI Responses config for the Copilot SDK provider contract", () => {
    expect(
      resolveModel(
        { ...azureModel, azureApiVersion: "2025-01-01-preview" },
        { resolvedApiKey: "azure-key" },
      ).provider,
    ).toEqual({
      ...azureExpected,
      baseUrl: "https://example.openai.azure.com",
      apiKey: "azure-key",
      azure: { apiVersion: "2025-01-01-preview" },
    });
    const cognitive = resolveModel({
      ...azureModel,
      baseUrl: "https://example.cognitiveservices.azure.com/openai/v1",
    }).provider;
    expect(cognitive).toMatchObject({
      type: "azure",
      baseUrl: "https://example.cognitiveservices.azure.com",
    });
    expect(cognitive).not.toHaveProperty("azure");
    const foundryUrl = "https://project.services.ai.azure.com/api/projects/demo/openai/v1";
    expect(
      resolveModel({ ...azureModel, baseUrl: foundryUrl }, { resolvedApiKey: "azure-key" })
        .provider,
    ).toEqual({
      ...azureExpected,
      type: "openai",
      baseUrl: foundryUrl,
      apiKey: "azure-key",
    });
  });

  it("does not forward local auth markers or null no-auth headers", () => {
    expect(
      resolveModel(
        {
          provider: "local-proxy",
          api: "openai-completions",
          id: "local-model",
          authHeader: true,
          headers: { Authorization: null, "X-Local": "true" },
        },
        { resolvedApiKey: "custom-local" },
      ).provider,
    ).toEqual({
      ...expectedProvider,
      wireApi: "completions",
      modelId: "local-model",
      wireModel: "local-model",
      headers: { "X-Local": "true" },
    });
  });

  it.each([
    { mode: "header", headers: { "x-api-key": "header-secret" } },
    { mode: "none", headers: undefined },
  ])("does not synthesize SDK auth for prepared $mode request auth", ({ mode, headers }) => {
    expect(
      resolveModel(
        { provider: "custom-header-proxy", headers, requestAuthMode: mode },
        { resolvedApiKey: "header-secret" },
      ).provider,
    ).toEqual({ ...expectedProvider, ...(headers ? { headers } : {}) });
  });

  it("rejects request transport policy the SDK provider config cannot enforce", () => {
    for (const model of [
      { requestProxy: { mode: "env-proxy" } },
      { requestTls: { ca: "ca-pem" } },
      { requestAllowPrivateNetwork: false },
    ]) {
      expect(() => resolveModel(model)).toThrow(
        "[copilot-attempt] BYOK does not support OpenClaw provider request proxy, TLS, or private-network policy overrides",
      );
    }
  });

  it("rejects BYOK endpoints blocked by OpenClaw SSRF policy", () => {
    for (const endpoint of [
      "file://public.example/v1",
      "ftp://public.example/v1",
      "http://proxy.example/v1",
      "https://user:pass@proxy.example/v1",
      "https://proxy.example/v1?api_key=secret",
      "https://proxy.example/v1?x-api-key=secret",
      "https://proxy.example/v1?x-auth-token=secret",
      "https://proxy.example/v1?password=secret",
      "https://proxy.example/v1?client%5Fse%E2%80%8Bcret=secret",
      "http://169.254.169.254/v1",
      "http://metadata.google.internal/v1",
      "http://localhost:11434/v1",
    ]) {
      expect(() => resolveModel({ baseUrl: endpoint })).toThrow(
        "[copilot-attempt] BYOK endpoint is blocked by OpenClaw SSRF policy",
      );
    }
  });

  it("advertises support only for representable BYOK provider shapes", () => {
    const supported = [
      { api: "openai-responses", baseUrl },
      azureModel,
      {
        ...azureModel,
        baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      },
    ];
    const unsupported = [
      { ...azureModel, baseUrl: "https://project.services.ai.azure.com/api/projects/demo" },
      { api: "google-generative-ai", baseUrl: "https://google.example" },
      ...[
        "file://public.example/v1",
        "http://proxy.example/v1",
        "https://user:pass@proxy.example/v1",
        "https://proxy.example/v1?api_key=secret",
        "https://proxy.example/v1?x-api-key=secret",
      ].map((endpoint) => ({ api: "openai-responses", baseUrl: endpoint })),
      { api: "openai-responses" },
      { api: "openai-responses", baseUrl, requestProxy: { mode: "env-proxy" } },
    ];
    expect(supported.map(supportsCopilotByokProviderShape)).toEqual([true, true, true]);
    expect(unsupported.map(supportsCopilotByokProviderShape)).toEqual(Array(9).fill(false));
  });

  it.each([
    {
      provider: "google",
      api: "google-generative-ai",
      id: "gemini",
      baseUrl: "https://google.example",
    },
    { provider: "custom", api: "openai-completions", id: "model", baseUrl: undefined },
  ] satisfies Array<Partial<Input["model"]>>)(
    "rejects an unrepresentable provider or missing endpoint: $provider",
    (model) => {
      expect(() => resolveModel(model)).toThrow(
        "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl",
      );
    },
  );
});
