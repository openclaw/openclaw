import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  buildAnthropicSdkProvider,
  buildZaiSdkProvider,
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
          // TypeScript doesn't know about `providers` yet (it's a proposed extension)
          // but the runtime check handles it via type assertion.
        },
      },
    };
    // Manually inject providers for the test.
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
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
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      zai: {
        env: {
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_AUTH_TOKEN: "literal-key",
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
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      zai: {
        env: {
          ANTHROPIC_AUTH_TOKEN: "${ZAI_CLAUDE_CODE_API_KEY}",
        },
      },
    };

    const env = { ZAI_CLAUDE_CODE_API_KEY: "resolved-from-env" } as NodeJS.ProcessEnv;
    const providers = resolveSdkProviders({ config, env });

    expect(providers[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("resolved-from-env");
  });

  it("returns empty string for missing ${VAR} references", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      zai: {
        env: {
          ANTHROPIC_AUTH_TOKEN: "${MISSING_VAR}",
        },
      },
    };

    const providers = resolveSdkProviders({ config, env: {} as NodeJS.ProcessEnv });
    expect(providers[0].config.env?.ANTHROPIC_AUTH_TOKEN).toBe("");
  });

  it("resolves multiple providers", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      anthropic: {},
      zai: {
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
        model: "glm-4.7",
        maxTurns: 30,
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
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      anthropic: {},
      zai: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("zai");
  });

  it("falls back to anthropic if no zai", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      anthropic: {},
      custom: { env: { ANTHROPIC_BASE_URL: "https://custom.example.com" } },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("anthropic");
  });

  it("falls back to first provider if neither zai nor anthropic", () => {
    const config: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    (config.tools!.codingTask as Record<string, unknown>).providers = {
      custom: { env: { ANTHROPIC_BASE_URL: "https://custom.example.com" } },
    };

    const provider = resolveDefaultSdkProvider({ config });
    expect(provider?.key).toBe("custom");
  });
});
