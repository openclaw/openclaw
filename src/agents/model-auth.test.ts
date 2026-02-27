import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  KEYLESS_LOCAL_PLACEHOLDER,
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

describe("resolveApiKeyForProvider — keyless local providers", () => {
  it("returns placeholder key for ollama when no auth is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const saved = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      const result = await resolveApiKeyForProvider({ provider: "ollama", agentDir });
      expect(result.apiKey).toBe(KEYLESS_LOCAL_PLACEHOLDER);
      expect(result.source).toBe("local-provider-default");
      expect(result.mode).toBe("api-key");
    } finally {
      if (saved !== undefined) {
        process.env.OLLAMA_API_KEY = saved;
      }
    }
  });

  it("returns placeholder key for vllm when no auth is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const saved = process.env.VLLM_API_KEY;
    delete process.env.VLLM_API_KEY;
    try {
      const result = await resolveApiKeyForProvider({ provider: "vllm", agentDir });
      expect(result.apiKey).toBe(KEYLESS_LOCAL_PLACEHOLDER);
      expect(result.source).toBe("local-provider-default");
    } finally {
      if (saved !== undefined) {
        process.env.VLLM_API_KEY = saved;
      }
    }
  });

  it("prefers real env key over placeholder for ollama", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "real-key";
    try {
      const result = await resolveApiKeyForProvider({ provider: "ollama", agentDir });
      expect(result.apiKey).toBe("real-key");
      expect(result.source).toContain("OLLAMA_API_KEY");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("still throws for non-local providers without auth", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await expect(resolveApiKeyForProvider({ provider: "anthropic", agentDir })).rejects.toThrow(
      'No API key found for provider "anthropic"',
    );
  });
});
