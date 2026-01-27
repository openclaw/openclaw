import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildAnthropicSdkProvider,
  buildZaiSdkProvider,
  enrichProvidersWithAuthProfiles,
  resolveApiKeyFromAuthProfile,
  resolveDefaultSdkProvider,
  resolveSdkProviders,
  isSdkRunnerEnabled,
} from "./sdk-runner.config.js";

// ---------------------------------------------------------------------------
// buildZaiSdkProvider
// ---------------------------------------------------------------------------

describe("buildZaiSdkProvider", () => {
  it("returns z.AI provider config with correct env vars", () => {
    const provider = buildZaiSdkProvider("my-zai-key");

    expect(provider.name).toBe("z.AI (GLM 4.7)");
    expect(provider.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(provider.env?.ANTHROPIC_AUTH_TOKEN).toBe("my-zai-key");
    expect(provider.env?.API_TIMEOUT_MS).toBe("3000000");
    expect(provider.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-4.7");
    expect(provider.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-4.7");
    expect(provider.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-4.5-air");
  });
});

// ---------------------------------------------------------------------------
// buildAnthropicSdkProvider
// ---------------------------------------------------------------------------

describe("buildAnthropicSdkProvider", () => {
  it("returns provider with no env override", () => {
    const provider = buildAnthropicSdkProvider();

    expect(provider.name).toBe("Anthropic (Claude Code)");
    expect(provider.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isSdkRunnerEnabled
// ---------------------------------------------------------------------------

describe("isSdkRunnerEnabled", () => {
  it("returns false when codingTask is not configured", () => {
    expect(isSdkRunnerEnabled(undefined)).toBe(false);
    expect(isSdkRunnerEnabled({})).toBe(false);
  });

  it("returns false when codingTask.enabled is false", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: false } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("returns false when enabled but no providers", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("returns true when enabled with providers", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
          },
        },
      },
    };
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  it("returns true when agents.defaults.runtime is sdk", () => {
    const config: ClawdbotConfig = {
      agents: { defaults: { runtime: "sdk" } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  it("returns false when agents.defaults.runtime is pi", () => {
    const config: ClawdbotConfig = {
      agents: { defaults: { runtime: "pi" } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("runtime toggle takes precedence over codingTask config", () => {
    const config: ClawdbotConfig = {
      agents: { defaults: { runtime: "sdk" } },
      tools: { codingTask: { enabled: false } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSdkProviders
// ---------------------------------------------------------------------------

describe("resolveSdkProviders", () => {
  it("returns empty array when no config", () => {
    expect(resolveSdkProviders({})).toEqual([]);
  });

  it("resolves providers with literal env values", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: {
              env: {
                ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
                ANTHROPIC_AUTH_TOKEN: "literal-key",
              },
            },
          },
        },
      },
    };

    const providers = resolveSdkProviders({ config });
    expect(providers).toHaveLength(1);
    expect(providers[0].key).toBe("zai");
    expect(providers[0].config.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(providers[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("literal-key");
  });

  it("resolves ${VAR} references from process env", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: {
              env: {
                ANTHROPIC_AUTH_TOKEN: "${ZAI_CLAUDE_CODE_API_KEY}",
              },
            },
          },
        },
      },
    };

    const env = { ZAI_CLAUDE_CODE_API_KEY: "resolved-from-env" } as NodeJS.ProcessEnv;
    const providers = resolveSdkProviders({ config, env });

    expect(providers[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("resolved-from-env");
  });

  it("returns empty string for missing ${VAR} references", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: {
              env: {
                ANTHROPIC_AUTH_TOKEN: "${MISSING_VAR}",
              },
            },
          },
        },
      },
    };

    const providers = resolveSdkProviders({ config, env: {} as NodeJS.ProcessEnv });
    expect(providers[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("");
  });

  it("resolves multiple providers", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            anthropic: {},
            zai: {
              env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
              model: "glm-4.7",
              maxTurns: 30,
            },
          },
        },
      },
    };

    const providers = resolveSdkProviders({ config });
    expect(providers).toHaveLength(2);

    const zai = providers.find((p) => p.key === "zai");
    expect(zai?.config.model).toBe("glm-4.7");
    expect(zai?.config.maxTurns).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultSdkProvider
// ---------------------------------------------------------------------------

describe("resolveDefaultSdkProvider", () => {
  it("returns undefined when no providers configured", () => {
    expect(resolveDefaultSdkProvider({})).toBeUndefined();
  });

  it("prefers zai provider", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            anthropic: {},
            zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
          },
        },
      },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("zai");
  });

  it("falls back to anthropic if no zai", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            anthropic: {},
            custom: { env: { ANTHROPIC_BASE_URL: "https://custom.example.com" } },
          },
        },
      },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("anthropic");
  });

  it("falls back to first provider if neither zai nor anthropic", () => {
    const config: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            custom: { env: { ANTHROPIC_BASE_URL: "https://custom.example.com" } },
          },
        },
      },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// Auth profile integration
// ---------------------------------------------------------------------------

describe("resolveApiKeyFromAuthProfile", () => {
  const makeStore = (profiles: AuthProfileStore["profiles"]): AuthProfileStore => ({
    version: 1,
    profiles,
  });

  it("returns undefined when no store", () => {
    expect(resolveApiKeyFromAuthProfile({ providerKey: "zai" })).toBeUndefined();
  });

  it("returns undefined for unknown provider", () => {
    const store = makeStore({});
    expect(resolveApiKeyFromAuthProfile({ providerKey: "unknown", store })).toBeUndefined();
  });

  it("resolves api_key credential for zai", () => {
    const store = makeStore({
      "zai:default": { type: "api_key", provider: "zai", key: "zai-key-123" },
    });
    expect(resolveApiKeyFromAuthProfile({ providerKey: "zai", store })).toBe("zai-key-123");
  });

  it("resolves token credential for anthropic", () => {
    const store = makeStore({
      "anthropic:default": { type: "token", provider: "anthropic", token: "ant-token-456" },
    });
    expect(resolveApiKeyFromAuthProfile({ providerKey: "anthropic", store })).toBe("ant-token-456");
  });

  it("returns undefined for missing profile", () => {
    const store = makeStore({});
    expect(resolveApiKeyFromAuthProfile({ providerKey: "zai", store })).toBeUndefined();
  });
});

describe("enrichProvidersWithAuthProfiles", () => {
  const makeStore = (profiles: AuthProfileStore["profiles"]): AuthProfileStore => ({
    version: 1,
    profiles,
  });

  it("returns providers unchanged when no store", () => {
    const providers = [{ key: "zai", config: { name: "zai" } }];
    expect(enrichProvidersWithAuthProfiles({ providers })).toEqual(providers);
  });

  it("injects auth token from profile for ${PROFILE} reference", () => {
    const store = makeStore({
      "zai:default": { type: "api_key", provider: "zai", key: "profile-key" },
    });
    const providers = [
      {
        key: "zai",
        config: {
          name: "zai",
          env: { ANTHROPIC_AUTH_TOKEN: "${PROFILE}", ANTHROPIC_BASE_URL: "https://api.z.ai" },
        },
      },
    ];
    const enriched = enrichProvidersWithAuthProfiles({ providers, store });
    expect(enriched[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("profile-key");
    expect(enriched[0].config.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai");
  });

  it("injects auth token for empty auth token value", () => {
    const store = makeStore({
      "zai:default": { type: "api_key", provider: "zai", key: "profile-key" },
    });
    const providers = [
      {
        key: "zai",
        config: { name: "zai", env: { ANTHROPIC_AUTH_TOKEN: "" } },
      },
    ];
    const enriched = enrichProvidersWithAuthProfiles({ providers, store });
    expect(enriched[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("profile-key");
  });

  it("does implicit lookup for non-anthropic providers without auth token", () => {
    const store = makeStore({
      "zai:default": { type: "api_key", provider: "zai", key: "implicit-key" },
    });
    const providers = [
      {
        key: "zai",
        config: { name: "zai", env: { ANTHROPIC_BASE_URL: "https://api.z.ai" } },
      },
    ];
    const enriched = enrichProvidersWithAuthProfiles({ providers, store });
    expect(enriched[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("implicit-key");
  });

  it("skips implicit lookup for anthropic provider", () => {
    const store = makeStore({
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "ant-key" },
    });
    const providers = [
      {
        key: "anthropic",
        config: { name: "anthropic" },
      },
    ];
    const enriched = enrichProvidersWithAuthProfiles({ providers, store });
    expect(enriched[0].config.env).toBeUndefined();
  });
});
