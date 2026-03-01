import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import {
  buildAllowedModelSet,
  inferUniqueProviderFromConfiguredModels,
  parseModelRef,
  buildModelAliasIndex,
  normalizeModelSelection,
  normalizeProviderId,
  modelKey,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen-portal");
      expect(normalizeProviderId("kimi-code")).toBe("kimi-coding");
      expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("parseModelRef", () => {
    it("should parse full model refs", () => {
      expect(parseModelRef("anthropic/claude-3-5-sonnet", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("preserves nested model ids after provider prefix", () => {
      expect(parseModelRef("nvidia/moonshotai/kimi-k2.5", "anthropic")).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
    });

    it("normalizes anthropic alias refs to canonical model ids", () => {
      expect(parseModelRef("anthropic/opus-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("opus-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(parseModelRef("anthropic/sonnet-4.6", "openai")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      expect(parseModelRef("sonnet-4.6", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("should use default provider if none specified", () => {
      expect(parseModelRef("claude-3-5-sonnet", "anthropic")).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
    });

    it("normalizes openai gpt-5.3 codex refs to openai-codex provider", () => {
      expect(parseModelRef("openai/gpt-5.3-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("gpt-5.3-codex", "openai")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      });
      expect(parseModelRef("openai/gpt-5.3-codex-codex", "anthropic")).toEqual({
        provider: "openai-codex",
        model: "gpt-5.3-codex-codex",
      });
    });

    it("should return null for empty strings", () => {
      expect(parseModelRef("", "anthropic")).toBeNull();
      expect(parseModelRef("  ", "anthropic")).toBeNull();
    });

    it("should preserve openrouter/ prefix for native models", () => {
      expect(parseModelRef("openrouter/aurora-alpha", "openai")).toEqual({
        provider: "openrouter",
        model: "openrouter/aurora-alpha",
      });
    });

    it("should pass through openrouter external provider models as-is", () => {
      expect(parseModelRef("openrouter/anthropic/claude-sonnet-4-5", "openai")).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("normalizes Vercel Claude shorthand to anthropic-prefixed model ids", () => {
      expect(parseModelRef("vercel-ai-gateway/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
      expect(parseModelRef("vercel-ai-gateway/opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4-6",
      });
    });

    it("keeps already-prefixed Vercel Anthropic models unchanged", () => {
      expect(parseModelRef("vercel-ai-gateway/anthropic/claude-opus-4.6", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.6",
      });
    });

    it("passes through non-Claude Vercel model ids unchanged", () => {
      expect(parseModelRef("vercel-ai-gateway/openai/gpt-5.2", "openai")).toEqual({
        provider: "vercel-ai-gateway",
        model: "openai/gpt-5.2",
      });
    });

    it("should handle invalid slash usage", () => {
      expect(parseModelRef("/", "anthropic")).toBeNull();
      expect(parseModelRef("anthropic/", "anthropic")).toBeNull();
      expect(parseModelRef("/model", "anthropic")).toBeNull();
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it("infers provider when configured model match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBe("anthropic");
    });

    it("returns undefined when configured matches are ambiguous", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "minimax/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for provider-prefixed model ids", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("infers provider for slash-containing model id when allowlist match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBe("vercel-ai-gateway");
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });
  });

  describe("buildAllowedModelSet", () => {
    it("keeps explicitly allowlisted models even when missing from bundled catalog", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedCatalog).toEqual([
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      ]);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it("accepts explicit allowlist refs absent from bundled catalog", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.2" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
      ];

      const result = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: "anthropic/claude-sonnet-4-6",
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
      });

      expect(result).toEqual({
        key: "anthropic/claude-sonnet-4-6",
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
    });

    it("strips trailing auth profile suffix before allowlist matching", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/@cf/openai/gpt-oss-20b": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual({
        key: "openai/@cf/openai/gpt-oss-20b",
        ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
      });
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { provider: "anthropic", model: "sonnet" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "anthropic", model: "sonnet" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/gpt-4",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("strips trailing profile suffix for simple model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "gpt-5@myprofile",
        defaultProvider: "openai",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-5" });
    });

    it("strips trailing profile suffix for provider/model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "google/gemini-flash-latest@google:bevfresh",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "google",
        model: "gemini-flash-latest",
      });
    });

    it("preserves Cloudflare @cf model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/@cf/openai/gpt-oss-20b",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openai",
        model: "@cf/openai/gpt-oss-20b",
      });
    });

    it("preserves OpenRouter @preset model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("splits trailing profile suffix after OpenRouter preset paths", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5@work",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("strips profile suffix before alias resolution", () => {
      const index = {
        byAlias: new Map([
          ["kimi", { alias: "kimi", ref: { provider: "nvidia", model: "moonshotai/kimi-k2.5" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "kimi@nvidia:default",
        defaultProvider: "openai",
        aliasIndex: index,
      });
      expect(resolved?.ref).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
      expect(resolved?.alias).toBe("kimi");
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should fall back to anthropic and warn if provider is missing for non-alias", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "claude-3-5-sonnet" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "google",
          defaultModel: "gemini-pro",
        });

        expect(result).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to "anthropic/claude-3-5-sonnet"'),
        );
      } finally {
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<OpenClawConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      });
      expect(result).toEqual({ provider: "openai", model: "gpt-4" });
    });
  });
});

describe("normalizeModelSelection", () => {
  it("returns trimmed string for string input", () => {
    expect(normalizeModelSelection("ollama/llama3.2:3b")).toBe("ollama/llama3.2:3b");
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(normalizeModelSelection("")).toBeUndefined();
    expect(normalizeModelSelection("   ")).toBeUndefined();
  });

  it("extracts primary from object", () => {
    expect(normalizeModelSelection({ primary: "google/gemini-2.5-flash" })).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns undefined for object without primary", () => {
    expect(normalizeModelSelection({ fallbacks: ["a"] })).toBeUndefined();
    expect(normalizeModelSelection({})).toBeUndefined();
  });

  it("returns undefined for null/undefined/number", () => {
    expect(normalizeModelSelection(undefined)).toBeUndefined();
    expect(normalizeModelSelection(null)).toBeUndefined();
    expect(normalizeModelSelection(42)).toBeUndefined();
  });
});
