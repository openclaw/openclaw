import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  requireApiKey,
  resolveApiKeyForProvider,
  resolveAwsSdkEnvVarName,
  resolveModelAuthMode,
} from "./model-auth.js";

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });

  it("returns aws-sdk for bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });

  it("returns aws-sdk for aws-bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("aws-bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "\n sk-test-abc\r\n",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow('No API key resolved for provider "openai"');
  });
});

describe("resolveApiKeyForProvider ollama keyless fallback", () => {
  const emptyStore: AuthProfileStore = { version: 1, profiles: {} };

  it("returns dummy key for ollama provider when no auth is configured", async () => {
    const result = await resolveApiKeyForProvider({
      provider: "ollama",
      store: emptyStore,
    });

    expect(result.apiKey).toBe("ollama");
    expect(result.source).toBe("ollama-local-default");
    expect(result.mode).toBe("api-key");
  });

  it("returns dummy key for vllm provider when no auth is configured", async () => {
    const result = await resolveApiKeyForProvider({
      provider: "vllm",
      store: emptyStore,
    });

    expect(result.apiKey).toBe("ollama");
    expect(result.source).toBe("ollama-local-default");
    expect(result.mode).toBe("api-key");
  });

  it("returns dummy key when provider config has api: ollama", async () => {
    const result = await resolveApiKeyForProvider({
      provider: "my-local-llm",
      cfg: {
        models: {
          providers: {
            "my-local-llm": {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      },
      store: emptyStore,
    });

    expect(result.apiKey).toBe("ollama");
    expect(result.source).toBe("ollama-local-default");
  });

  it("prefers explicit config apiKey over ollama fallback", async () => {
    const result = await resolveApiKeyForProvider({
      provider: "ollama",
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              apiKey: "my-custom-key",
              models: [],
            },
          },
        },
      },
      store: emptyStore,
    });

    expect(result.apiKey).toBe("my-custom-key");
    expect(result.source).toBe("models.json");
  });

  it("skips keyless fallback when explicit auth override is set", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "ollama",
        cfg: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                auth: "token",
                models: [],
              },
            },
          },
        },
        store: emptyStore,
      }),
    ).rejects.toThrow('No API key found for provider "ollama"');
  });
});
