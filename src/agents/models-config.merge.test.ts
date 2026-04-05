import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  mergeProviderModels,
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

describe("models-config merge helpers", () => {
  const preservedApiKey = "AGENT_KEY"; // pragma: allowlist secret
  const configApiKey = "CONFIG_KEY"; // pragma: allowlist secret

  function createConfigProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      baseUrl: "https://config.example/v1",
      apiKey: configApiKey,
      api: "openai-responses",
      models: [
        {
          id: "config-model",
          name: "Config model",
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ],
      ...overrides,
    } as ProviderConfig;
  }

  function createExistingProvider(
    overrides: Partial<ExistingProviderConfig> = {},
  ): ExistingProviderConfig {
    return {
      baseUrl: "https://agent.example/v1",
      apiKey: preservedApiKey,
      api: "openai-responses",
      models: [{ id: "agent-model", name: "Agent model", input: ["text"] }],
      ...overrides,
    } as ExistingProviderConfig;
  }

  it("refreshes implicit model metadata while preserving explicit reasoning overrides", () => {
    const merged = mergeProviderModels(
      {
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            input: ["text"],
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 100_000,
          },
        ],
      } as ProviderConfig,
      {
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            input: ["image"],
            reasoning: false,
            cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 2_000_000,
            maxTokens: 200_000,
          },
        ],
      } as ProviderConfig,
    );

    expect(merged.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.4",
        input: ["text"],
        reasoning: false,
        cost: { input: 123, output: 456, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 2_000_000,
        maxTokens: 200_000,
      }),
    ]);
  });

  it("merges explicit providers onto trimmed keys", () => {
    const merged = mergeProviders({
      explicit: {
        " custom ": {
          api: "openai-responses",
          models: [] as ProviderConfig["models"],
        } as ProviderConfig,
      },
    });

    expect(merged).toEqual({
      custom: expect.objectContaining({ api: "openai-responses" }),
    });
  });

  it("keeps existing providers alongside newly configured providers in merge mode", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        "custom-proxy": {
          baseUrl: "http://localhost:4000/v1",
          api: "openai-completions",
          models: [],
        } as ProviderConfig,
      },
      existingProviders: {
        existing: {
          baseUrl: "http://localhost:1234/v1",
          apiKey: "EXISTING_KEY", // pragma: allowlist secret
          api: "openai-completions",
          models: [{ id: "existing-model", name: "Existing", input: ["text"] }],
        } as ExistingProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom-proxy"]),
    });

    expect(merged.existing?.baseUrl).toBe("http://localhost:1234/v1");
    expect(merged["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
  });

  it("preserves non-empty existing apiKey while explicit baseUrl wins", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: createConfigProvider(),
      },
      existingProviders: {
        custom: createExistingProvider(),
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom"]),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("preserves existing apiKey after explicit provider key normalization", () => {
    const normalized = mergeProviders({
      explicit: {
        " custom ": createConfigProvider(),
      },
    });
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: normalized,
      existingProviders: {
        custom: createExistingProvider(),
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom"]),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("preserves implicit provider headers when explicit config adds extra headers", () => {
    const merged = mergeProviderModels(
      {
        baseUrl: "https://api.example.com",
        api: "anthropic-messages",
        headers: { "User-Agent": "claude-code/0.1.0" },
        models: [
          {
            id: "kimi-code",
            name: "Kimi Code",
            input: ["text", "image"],
            reasoning: true,
          },
        ],
      } as unknown as ProviderConfig,
      {
        baseUrl: "https://api.example.com",
        api: "anthropic-messages",
        headers: { "X-Kimi-Tenant": "tenant-a" },
        models: [
          {
            id: "kimi-code",
            name: "Kimi Code",
            input: ["text", "image"],
            reasoning: true,
          },
        ],
      } as unknown as ProviderConfig,
    );

    expect(merged.headers).toEqual({
      "User-Agent": "claude-code/0.1.0",
      "X-Kimi-Tenant": "tenant-a",
    });
  });

  it("replaces stale baseUrl when model api surface changes", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: {
          baseUrl: "https://config.example/v1",
          models: [{ id: "model", api: "openai-responses" }],
        } as ProviderConfig,
      },
      existingProviders: {
        custom: {
          baseUrl: "https://agent.example/v1",
          apiKey: preservedApiKey,
          models: [{ id: "model", api: "openai-completions" }],
        } as ExistingProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(),
    });

    expect(merged.custom).toEqual(
      expect.objectContaining({
        apiKey: preservedApiKey,
        baseUrl: "https://config.example/v1",
      }),
    );
  });

  it("replaces stale baseUrl when only model-level apis change", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: createConfigProvider({ api: "" }),
      },
      existingProviders: {
        custom: createExistingProvider({
          api: "",
          models: [
            { id: "agent-model", name: "Agent model", input: ["text"], api: "openai-completions" },
          ],
        }),
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom"]),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("does not preserve stale plaintext apiKey when next entry is a marker", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: {
          apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
          models: [{ id: "model", api: "openai-responses" }],
        } as ProviderConfig,
      },
      existingProviders: {
        custom: {
          apiKey: preservedApiKey,
          models: [{ id: "model", api: "openai-responses" }],
        } as ExistingProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
  });

  it("does not preserve a stale non-env marker when config returns to plaintext", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: createConfigProvider({ apiKey: "ALLCAPS_SAMPLE" }), // pragma: allowlist secret
      },
      existingProviders: {
        custom: createExistingProvider({
          apiKey: NON_ENV_SECRETREF_MARKER,
        }),
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom"]),
    });

    expect(merged.custom?.apiKey).toBe("ALLCAPS_SAMPLE"); // pragma: allowlist secret
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("uses config apiKey/baseUrl when existing values are empty", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: createConfigProvider(),
      },
      existingProviders: {
        custom: createExistingProvider({
          apiKey: "",
          baseUrl: "",
        }),
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(["custom"]),
    });

    expect(merged.custom?.apiKey).toBe(configApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });
});
