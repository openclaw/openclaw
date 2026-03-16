import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { streamSimpleOpenAICompletions, type Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { CUSTOM_LOCAL_AUTH_MARKER, NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  applyLocalNoAuthHeaderOverride,
  hasUsableCustomProviderApiKey,
  requireApiKey,
  resolveApiKeyForProvider,
  resolveAwsSdkEnvVarName,
  resolveModelAuthMode,
  resolveUsableCustomProviderApiKey,
} from "./model-auth.js";

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret", // pragma: allowlist secret
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret", // pragma: allowlist secret
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

describe("resolveUsableCustomProviderApiKey", () => {
  it("returns literal custom provider keys", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKey: "sk-custom-runtime", // pragma: allowlist secret
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });
    expect(resolved).toEqual({
      apiKey: "sk-custom-runtime",
      source: "models.json",
    });
  });

  it("does not treat non-env markers as usable credentials", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKey: NON_ENV_SECRETREF_MARKER,
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });
    expect(resolved).toBeNull();
  });

  it("resolves known env marker names from process env for custom providers", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: "OPENAI_API_KEY",
                models: [],
              },
            },
          },
        },
        provider: "custom",
      });
      expect(resolved?.apiKey).toBe("sk-from-env");
      expect(resolved?.source).toContain("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("does not treat known env marker names as usable when env value is missing", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(
        hasUsableCustomProviderApiKey(
          {
            models: {
              providers: {
                custom: {
                  baseUrl: "https://example.com/v1",
                  apiKey: "OPENAI_API_KEY",
                  models: [],
                },
              },
            },
          },
          "custom",
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("reads custom provider api keys from apiKeyFile", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-auth-"));
    const apiKeyFile = path.join(tempDir, "openai.key");
    try {
      await fs.writeFile(apiKeyFile, "sk-from-file\n", "utf8");

      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKeyFile,
                models: [],
              },
            },
          },
        },
        provider: "custom",
      });

      expect(resolved).toEqual({
        apiKey: "sk-from-file",
        source: "apiKeyFile",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers apiKeyFile over inline apiKey for custom providers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-auth-"));
    const apiKeyFile = path.join(tempDir, "openai.key");
    try {
      await fs.writeFile(apiKeyFile, "sk-from-file\n", "utf8");

      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKeyFile,
                apiKey: "sk-inline-should-not-win", // pragma: allowlist secret
                models: [],
              },
            },
          },
        },
        provider: "custom",
      });

      expect(resolved).toEqual({
        apiKey: "sk-from-file",
        source: "apiKeyFile",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to inline apiKey when configured apiKeyFile is unreadable", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKeyFile: "/tmp/does-not-exist-openclaw-api-key",
              apiKey: "sk-inline-should-not-fallback", // pragma: allowlist secret
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });

    expect(resolved).toBeNull();
  });
});

describe("resolveApiKeyForProvider – synthetic local auth for custom providers", () => {
  it("synthesizes a local auth marker for custom providers with a local baseUrl and no apiKey", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "custom-127-0-0-1-8080",
      cfg: {
        models: {
          providers: {
            "custom-127-0-0-1-8080": {
              baseUrl: "http://127.0.0.1:8080/v1",
              api: "openai-completions",
              models: [
                {
                  id: "qwen-3.5",
                  name: "Qwen 3.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(auth.source).toContain("synthetic local key");
  });

  it("synthesizes a local auth marker for localhost custom providers", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "my-local",
      cfg: {
        models: {
          providers: {
            "my-local": {
              baseUrl: "http://localhost:11434/v1",
              api: "openai-completions",
              models: [
                {
                  id: "llama3",
                  name: "Llama 3",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for IPv6 loopback (::1)", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "my-ipv6",
      cfg: {
        models: {
          providers: {
            "my-ipv6": {
              baseUrl: "http://[::1]:8080/v1",
              api: "openai-completions",
              models: [
                {
                  id: "llama3",
                  name: "Llama 3",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for 0.0.0.0", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "my-wildcard",
      cfg: {
        models: {
          providers: {
            "my-wildcard": {
              baseUrl: "http://0.0.0.0:11434/v1",
              api: "openai-completions",
              models: [
                {
                  id: "qwen",
                  name: "Qwen",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for IPv4-mapped IPv6 (::ffff:127.0.0.1)", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "my-mapped",
      cfg: {
        models: {
          providers: {
            "my-mapped": {
              baseUrl: "http://[::ffff:127.0.0.1]:8080/v1",
              api: "openai-completions",
              models: [
                {
                  id: "llama3",
                  name: "Llama 3",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("does not synthesize auth for remote custom providers without apiKey", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "my-remote",
        cfg: {
          models: {
            providers: {
              "my-remote": {
                baseUrl: "https://api.example.com/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "gpt-5",
                    name: "GPT-5",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
      }),
    ).rejects.toThrow("No API key found");
  });

  it("does not synthesize local auth when apiKey is explicitly configured but unresolved", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        resolveApiKeyForProvider({
          provider: "custom",
          cfg: {
            models: {
              providers: {
                custom: {
                  baseUrl: "http://127.0.0.1:8080/v1",
                  api: "openai-completions",
                  apiKey: "OPENAI_API_KEY",
                  models: [
                    {
                      id: "llama3",
                      name: "Llama 3",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 8192,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
          },
        }),
      ).rejects.toThrow('No API key found for provider "custom"');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("does not synthesize local auth when auth mode explicitly requires oauth", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "custom",
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "http://127.0.0.1:8080/v1",
                api: "openai-completions",
                auth: "oauth",
                models: [
                  {
                    id: "llama3",
                    name: "Llama 3",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
      }),
    ).rejects.toThrow('No API key found for provider "custom"');
  });

  it("keeps built-in aws-sdk fallback for local baseUrl overrides", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "amazon-bedrock",
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(auth.mode).toBe("aws-sdk");
    expect(auth.apiKey).toBeUndefined();
  });
});

describe("applyLocalNoAuthHeaderOverride", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("clears Authorization for synthetic local OpenAI-compatible auth markers", async () => {
    let capturedAuthorization: string | null | undefined;
    let capturedXTest: string | null | undefined;
    let resolveRequest: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async (_input, init) => {
        const headers = new Headers(init?.headers);
        capturedAuthorization = headers.get("Authorization");
        capturedXTest = headers.get("X-Test");
        resolveRequest?.();
        return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }),
    );

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

    streamSimpleOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      },
    );

    await requestSeen;

    expect(capturedAuthorization).toBeNull();
    expect(capturedXTest).toBe("1");
  });
});
