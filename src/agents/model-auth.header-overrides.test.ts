// Verifies model auth header overrides and SecretRef header sentinels.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  applySecretRefHeaderSentinels,
} from "./model-auth.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";

beforeEach(() => {
  clearRuntimeConfigSnapshot();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

function providerEntry<T extends Omit<ModelProviderConfig, "baseUrl" | "models">>(
  baseUrl: string,
  options: T,
) {
  const models: ModelProviderConfig["models"] = [];
  return { baseUrl, models, ...options };
}

function configForProviders<T extends Record<string, ModelProviderConfig>>(providers: T) {
  return { models: { providers } };
}

describe("applyLocalNoAuthHeaderOverride", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks synthetic local OpenAI-compatible auth so SDK request headers clear Authorization", () => {
    const model = applyLocalNoAuthHeaderOverride(
      {
        id: "local-llm",
        name: "local-llm",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
        headers: { "X-Test": "1" },
      } as Model<"openai-completions">,
      {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.custom (synthetic local key)",
        mode: "api-key",
      },
    );

    expect(model.headers?.Authorization).toBeNull();
    expect(model.headers?.["X-Test"]).toBe("1");
  });
});

describe("applyAuthHeaderOverride", () => {
  const baseModel: Model<"openai-completions"> = {
    id: "gemini-3.1-flash-lite",
    name: "gemini-3.1-flash-lite",
    api: "openai-completions" as const,
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };

  it("sentinelizes SecretRef-managed provider headers from the runtime snapshot", () => {
    const sourceConfig = configForProviders({
      google: providerEntry("https://generativelanguage.googleapis.com/v1beta/openai", {
        api: "openai-completions" as const,
        headers: {
          Authorization: "secretref-env:GOOGLE_AUTH_TOKEN",
          "X-Managed": NON_ENV_SECRETREF_MARKER,
        },
      }),
    });
    const runtimeConfig = configForProviders({
      google: {
        ...sourceConfig.models.providers.google,
        headers: {
          Authorization: "Bearer runtime-google-secret",
          "X-Managed": "runtime-managed-secret",
        },
      },
    });
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applyAuthHeaderOverride(
      {
        ...baseModel,
        headers: {
          Authorization: "Bearer runtime-google-secret",
          "X-Managed": "runtime-managed-secret",
          "X-Plain": "visible",
        },
      },
      null,
      sourceConfig,
    );

    expect(looksLikeSecretSentinel(result.headers?.Authorization ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.headers?.Authorization ?? "")).toBe(
      "Bearer runtime-google-secret",
    );
    expect(looksLikeSecretSentinel(result.headers?.["X-Managed"] ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.headers?.["X-Managed"] ?? "")).toBe(
      "runtime-managed-secret",
    );
    expect(result.headers?.["X-Plain"]).toBe("visible");
  });

  it("sentinelizes SecretRef-managed request headers and composed auth", () => {
    const sourceConfig = configForProviders({
      google: providerEntry("https://generativelanguage.googleapis.com/v1beta/openai", {
        api: "openai-completions" as const,
        request: {
          headers: { "X-Managed": NON_ENV_SECRETREF_MARKER },
          auth: {
            mode: "authorization-bearer" as const,
            token: "secretref-env:GOOGLE_BEARER_TOKEN",
          },
        },
      }),
    });
    const runtimeConfig = configForProviders({
      google: {
        ...sourceConfig.models.providers.google,
        request: {
          headers: { "X-Managed": "runtime-managed-secret" },
          auth: {
            mode: "authorization-bearer" as const,
            token: "runtime-bearer-secret",
          },
        },
      },
    });
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applySecretRefHeaderSentinels(
      attachModelProviderRequestTransport(
        {
          ...baseModel,
          headers: {
            "X-Managed": "runtime-managed-secret",
            Authorization: "Bearer runtime-bearer-secret",
          },
        },
        runtimeConfig.models.providers.google.request,
      ),
      sourceConfig,
    );

    const managedSentinel = result.headers?.["X-Managed"] ?? "";
    expect(looksLikeSecretSentinel(managedSentinel)).toBe(true);
    expect(resolveSecretSentinel(managedSentinel)).toBe("runtime-managed-secret");
    const bearerSentinel = result.headers?.Authorization?.slice("Bearer ".length) ?? "";
    expect(looksLikeSecretSentinel(bearerSentinel)).toBe(true);
    expect(resolveSecretSentinel(bearerSentinel)).toBe("runtime-bearer-secret");
    const request = getModelProviderRequestTransport(result);
    const requestHeaderSentinel = request?.headers?.["X-Managed"] ?? "";
    expect(looksLikeSecretSentinel(requestHeaderSentinel)).toBe(true);
    expect(resolveSecretSentinel(requestHeaderSentinel)).toBe("runtime-managed-secret");
    expect(request?.auth?.mode).toBe("authorization-bearer");
    const requestTokenSentinel =
      request?.auth?.mode === "authorization-bearer" ? request.auth.token : "";
    expect(looksLikeSecretSentinel(requestTokenSentinel)).toBe(true);
    expect(resolveSecretSentinel(requestTokenSentinel)).toBe("runtime-bearer-secret");
  });

  const baseAuth = { apiKey: "test-api-key", source: "env", mode: "api-key" } as const;
  const provider = providerEntry(baseModel.baseUrl, { api: baseModel.api });
  const enabledConfig = configForProviders({ google: { ...provider, authHeader: true } });

  it.each([
    {
      name: "authHeader is not set",
      cfg: configForProviders({ google: provider }),
      auth: baseAuth,
    },
    {
      name: "authHeader is false",
      cfg: configForProviders({ google: { ...provider, authHeader: false } }),
      auth: baseAuth,
    },
    { name: "no API key is available", cfg: enabledConfig, auth: null },
    { name: "provider config is missing", cfg: undefined, auth: baseAuth },
    {
      name: "API key is a synthetic marker",
      cfg: enabledConfig,
      auth: { ...baseAuth, apiKey: CUSTOM_LOCAL_AUTH_MARKER, source: "synthetic" },
    },
  ])("returns model unchanged when $name", ({ cfg, auth }) => {
    expect(applyAuthHeaderOverride(baseModel, auth, cfg)).toBe(baseModel);
  });

  it("strips existing authorization header case-insensitively before injection", () => {
    const result = applyAuthHeaderOverride(
      { ...baseModel, headers: { authorization: "old-value", "X-Custom": "keep" } },
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      enabledConfig,
    );

    expect(result.headers).toEqual({
      "X-Custom": "keep",
      Authorization: "Bearer test-api-key",
    });
  });
});
