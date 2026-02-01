import { describe, expect, it } from "vitest";

import type { ClawdbrainConfig } from "../../config/config.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildAnthropicSdkProvider,
  buildOpenRouterSdkProvider,
  buildZaiSdkProvider,
  enrichProvidersWithAuthProfiles,
  resolveApiKeyFromAuthProfile,
  resolveDefaultSdkProvider,
  resolveSdkProviders,
  resolveWellKnownProvider,
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
  it("returns false when runtime is not configured", () => {
    expect(isSdkRunnerEnabled(undefined)).toBe(false);
    expect(isSdkRunnerEnabled({})).toBe(false);
  });

  it("returns false when agents.main.runtime is pi", () => {
    const config: ClawdbrainConfig = {
      agents: { main: { runtime: "pi" } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(false);
  });

  it("returns true when agents.main.runtime is ccsdk", () => {
    const config: ClawdbrainConfig = {
      agents: { main: { runtime: "ccsdk" } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  it("falls back to agents.defaults.runtime when agents.main.runtime is unset", () => {
    const config: ClawdbrainConfig = {
      agents: { defaults: { runtime: "ccsdk" } },
    };
    expect(isSdkRunnerEnabled(config)).toBe(true);
  });

  describe("mainRuntime override", () => {
    it("mainRuntime=ccsdk enables SDK for main agent", () => {
      const config: ClawdbrainConfig = {
        agents: { defaults: { mainRuntime: "ccsdk" } },
      };
      expect(isSdkRunnerEnabled(config, "main")).toBe(true);
    });

    it("mainRuntime=ccsdk does not affect non-main agents", () => {
      const config: ClawdbrainConfig = {
        agents: { defaults: { mainRuntime: "ccsdk" } },
      };
      expect(isSdkRunnerEnabled(config, "assistant2")).toBe(false);
    });

    it("mainRuntime=pi overrides global runtime=ccsdk for main agent", () => {
      const config: ClawdbrainConfig = {
        agents: { defaults: { mainRuntime: "pi", runtime: "ccsdk" } },
      };
      expect(isSdkRunnerEnabled(config, "main")).toBe(false);
      expect(isSdkRunnerEnabled(config, "assistant2")).toBe(true);
    });

    it("falls back to runtime when mainRuntime is not set", () => {
      const config: ClawdbrainConfig = {
        agents: { defaults: { runtime: "ccsdk" } },
      };
      expect(isSdkRunnerEnabled(config, "main")).toBe(true);
    });

    it("no agentId falls back to runtime (backward compat)", () => {
      const config: ClawdbrainConfig = {
        agents: { defaults: { mainRuntime: "ccsdk" } },
      };
      expect(isSdkRunnerEnabled(config)).toBe(false);
    });
  });

  it("does not enable SDK runtime from tools.codingTask config", () => {
    const config: ClawdbrainConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
          },
        },
      },
    };
    expect(isSdkRunnerEnabled(config)).toBe(false);
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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
    const config: ClawdbrainConfig = {
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

// ---------------------------------------------------------------------------
// buildOpenRouterSdkProvider
// ---------------------------------------------------------------------------

describe("buildOpenRouterSdkProvider", () => {
  it("returns provider with OpenRouter base URL", () => {
    const provider = buildOpenRouterSdkProvider();
    expect(provider.name).toBe("OpenRouter");
    expect(provider.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
  });

  it("does not pre-fill ANTHROPIC_AUTH_TOKEN", () => {
    const provider = buildOpenRouterSdkProvider();
    expect(provider.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveWellKnownProvider
// ---------------------------------------------------------------------------

describe("resolveWellKnownProvider", () => {
  it("returns Anthropic provider for 'anthropic'", () => {
    const entry = resolveWellKnownProvider("anthropic");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("anthropic");
    expect(entry!.config.name).toBe("Anthropic (Claude Code)");
  });

  it("returns z.AI provider (without API key) for 'zai'", () => {
    const entry = resolveWellKnownProvider("zai");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("zai");
    expect(entry!.config.name).toBe("z.AI (GLM 4.7)");
    expect(entry!.config.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(entry!.config.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
  });

  it("returns OpenRouter provider for 'openrouter'", () => {
    const entry = resolveWellKnownProvider("openrouter");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("openrouter");
    expect(entry!.config.name).toBe("OpenRouter");
    expect(entry!.config.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
  });

  it("returns undefined for unknown keys", () => {
    expect(resolveWellKnownProvider("unknown")).toBeUndefined();
    expect(resolveWellKnownProvider("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mainCcsdkProvider resolution
// ---------------------------------------------------------------------------

describe("mainCcsdkProvider resolution", () => {
  it("mainCcsdkProvider: 'openrouter' returns OpenRouter entry", () => {
    const config: ClawdbrainConfig = {
      agents: { defaults: { mainCcsdkProvider: "openrouter" } },
    };
    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("openrouter");
    expect(provider?.config.name).toBe("OpenRouter");
  });

  it("mainCcsdkProvider: 'zai' returns z.AI entry (no API key)", () => {
    const config: ClawdbrainConfig = {
      agents: { defaults: { mainCcsdkProvider: "zai" } },
    };
    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("zai");
    expect(provider?.config.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("mainCcsdkProvider: 'anthropic' returns Anthropic entry", () => {
    const config: ClawdbrainConfig = {
      agents: { defaults: { mainCcsdkProvider: "anthropic" } },
    };
    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("anthropic");
    expect(provider?.config.name).toBe("Anthropic (Claude Code)");
  });

  it("mainCcsdkProvider takes precedence over tools.codingTask.providers", () => {
    const config: ClawdbrainConfig = {
      agents: { defaults: { mainCcsdkProvider: "openrouter" } },
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
          },
        },
      },
    };
    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("openrouter");
  });

  it("falls back to tools.codingTask.providers when mainCcsdkProvider is unset", () => {
    const config: ClawdbrainConfig = {
      tools: {
        codingTask: {
          enabled: true,
          providers: {
            anthropic: {},
          },
        },
      },
    };
    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Per-agent runtime and provider overrides
// ---------------------------------------------------------------------------

describe("Per-agent runtime overrides", () => {
  it("per-agent runtime=ccsdk overrides global runtime=pi", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { runtime: "pi" },
        list: [{ id: "worker1", runtime: "ccsdk" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "worker1")).toBe(true);
  });

  it("per-agent runtime=pi overrides global runtime=ccsdk", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { runtime: "ccsdk" },
        list: [{ id: "worker1", runtime: "pi" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "worker1")).toBe(false);
  });

  it("per-agent runtime overrides mainRuntime for main agent", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { mainRuntime: "pi", runtime: "ccsdk" },
        list: [{ id: "main", runtime: "ccsdk" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "main")).toBe(true);
  });

  it("agents without per-agent runtime fall back to mainRuntime (main)", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { mainRuntime: "ccsdk" },
        list: [{ id: "main" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "main")).toBe(true);
  });

  it("agents without per-agent runtime fall back to global runtime (worker)", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { runtime: "ccsdk" },
        list: [{ id: "worker1" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "worker1")).toBe(true);
  });

  it("per-agent runtime for non-existent agent falls back gracefully", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { runtime: "pi" },
        list: [{ id: "worker1", runtime: "ccsdk" }],
      },
    };
    expect(isSdkRunnerEnabled(config, "worker2")).toBe(false);
  });
});

describe("Per-agent provider overrides", () => {
  it("per-agent ccsdkProvider overrides global ccsdkProvider", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { ccsdkProvider: "anthropic" },
        list: [{ id: "worker1", ccsdkProvider: "zai" }],
      },
    };
    const provider = resolveDefaultSdkProvider({ config, agentId: "worker1" });
    expect(provider?.key).toBe("zai");
  });

  it("per-agent ccsdkProvider overrides mainCcsdkProvider for main agent", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { mainCcsdkProvider: "anthropic" },
        list: [{ id: "main", ccsdkProvider: "openrouter" }],
      },
    };
    const provider = resolveDefaultSdkProvider({ config, agentId: "main" });
    expect(provider?.key).toBe("openrouter");
  });

  it("agents without per-agent provider fall back to mainCcsdkProvider (main)", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { mainCcsdkProvider: "zai" },
        list: [{ id: "main" }],
      },
    };
    const provider = resolveDefaultSdkProvider({ config, agentId: "main" });
    expect(provider?.key).toBe("zai");
  });

  it("agents without per-agent provider fall back to ccsdkProvider (worker)", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { ccsdkProvider: "openrouter" },
        list: [{ id: "worker1" }],
      },
    };
    const provider = resolveDefaultSdkProvider({ config, agentId: "worker1" });
    expect(provider?.key).toBe("openrouter");
  });

  it("per-agent provider for non-existent agent falls back gracefully", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { ccsdkProvider: "anthropic" },
        list: [{ id: "worker1", ccsdkProvider: "zai" }],
      },
    };
    const provider = resolveDefaultSdkProvider({ config, agentId: "worker2" });
    expect(provider?.key).toBe("anthropic");
  });

  it("mixed per-agent overrides work independently", () => {
    const config: ClawdbrainConfig = {
      agents: {
        defaults: { runtime: "pi", ccsdkProvider: "anthropic" },
        list: [
          { id: "main", runtime: "ccsdk", ccsdkProvider: "zai" },
          { id: "worker1", runtime: "ccsdk", ccsdkProvider: "openrouter" },
          { id: "worker2", runtime: "pi" },
        ],
      },
    };

    // Main agent
    expect(isSdkRunnerEnabled(config, "main")).toBe(true);
    const mainProvider = resolveDefaultSdkProvider({ config, agentId: "main" });
    expect(mainProvider?.key).toBe("zai");

    // Worker1
    expect(isSdkRunnerEnabled(config, "worker1")).toBe(true);
    const worker1Provider = resolveDefaultSdkProvider({ config, agentId: "worker1" });
    expect(worker1Provider?.key).toBe("openrouter");

    // Worker2
    expect(isSdkRunnerEnabled(config, "worker2")).toBe(false);
  });
});
