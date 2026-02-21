import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  parseModelRef,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
  buildModelAliasIndex,
  normalizeProviderId,
  modelKey,
  buildConfiguredAllowlistKeys,
  buildAllowedModelSet,
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

    it("should handle invalid slash usage", () => {
      expect(parseModelRef("/", "anthropic")).toBeNull();
      expect(parseModelRef("anthropic/", "anthropic")).toBeNull();
      expect(parseModelRef("/model", "anthropic")).toBeNull();
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
  });

  describe("resolveConfiguredModelRef", () => {
    it("should fall back to anthropic and warn if provider is missing for non-alias", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      warnSpy.mockRestore();
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

  describe("inverted alias format", () => {
    describe("buildModelAliasIndex", () => {
      it("should handle inverted format where key is shorthand and alias is full path", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                flash: { alias: "google/gemini-2.5-flash" },
                pro: { alias: "google/gemini-2.5-pro" },
              },
            },
          },
        };

        const index = buildModelAliasIndex({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "anthropic",
        });

        // The alias map should use the short name (keyRaw) as the alias
        expect(index.byAlias.get("flash")?.alias).toBe("flash");
        expect(index.byAlias.get("flash")?.ref).toEqual({
          provider: "google",
          model: "gemini-2.5-flash",
        });

        expect(index.byAlias.get("pro")?.alias).toBe("pro");
        expect(index.byAlias.get("pro")?.ref).toEqual({
          provider: "google",
          model: "gemini-2.5-pro",
        });

        // The byKey map should contain the short names
        expect(index.byKey.get(modelKey("google", "gemini-2.5-flash"))).toEqual(["flash"]);
        expect(index.byKey.get(modelKey("google", "gemini-2.5-pro"))).toEqual(["pro"]);
      });

      it("should handle standard format where key is full path and alias is shorthand", () => {
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

        expect(index.byAlias.get("fast")?.alias).toBe("fast");
        expect(index.byAlias.get("fast")?.ref).toEqual({
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        });

        expect(index.byAlias.get("smart")?.alias).toBe("smart");
        expect(index.byAlias.get("smart")?.ref).toEqual({
          provider: "openai",
          model: "gpt-4o",
        });
      });

      it("should handle mixed standard and inverted formats", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-3-5-sonnet": { alias: "fast" },
                flash: { alias: "google/gemini-2.5-flash" },
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
        expect(index.byAlias.get("flash")?.ref).toEqual({
          provider: "google",
          model: "gemini-2.5-flash",
        });
      });
    });

    describe("buildConfiguredAllowlistKeys", () => {
      it("should include resolved models from inverted alias format", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                flash: { alias: "google/gemini-2.5-flash" },
                pro: { alias: "google/gemini-2.5-pro" },
              },
            },
          },
        };

        const keys = buildConfiguredAllowlistKeys({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "anthropic",
        });

        expect(keys).not.toBeNull();
        expect(keys?.has("google/gemini-2.5-flash")).toBe(true);
        expect(keys?.has("google/gemini-2.5-pro")).toBe(true);
        // Should NOT include the shorthand names as keys
        expect(keys?.has("anthropic/flash")).toBe(false);
        expect(keys?.has("anthropic/pro")).toBe(false);
      });

      it("should include models from standard format", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-3-5-sonnet": { alias: "fast" },
                "openai/gpt-4o": {},
              },
            },
          },
        };

        const keys = buildConfiguredAllowlistKeys({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "anthropic",
        });

        expect(keys).not.toBeNull();
        expect(keys?.has("anthropic/claude-3-5-sonnet")).toBe(true);
        expect(keys?.has("openai/gpt-4o")).toBe(true);
      });

      it("should handle mixed standard and inverted formats", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-3-5-sonnet": { alias: "fast" },
                flash: { alias: "google/gemini-2.5-flash" },
              },
            },
          },
        };

        const keys = buildConfiguredAllowlistKeys({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "anthropic",
        });

        expect(keys).not.toBeNull();
        expect(keys?.has("anthropic/claude-3-5-sonnet")).toBe(true);
        expect(keys?.has("google/gemini-2.5-flash")).toBe(true);
      });
    });

    describe("buildAllowedModelSet", () => {
      it("should allow models from inverted alias format", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                flash: { alias: "google/gemini-2.5-flash" },
              },
            },
          },
        };

        const catalog: ModelCatalogEntry[] = [
          { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ];

        const result = buildAllowedModelSet({
          cfg: cfg as OpenClawConfig,
          catalog,
          defaultProvider: "anthropic",
          defaultModel: "claude-3-5-sonnet",
        });

        expect(result.allowAny).toBe(false);
        expect(result.allowedKeys.has("google/gemini-2.5-flash")).toBe(true);
        expect(result.allowedCatalog).toHaveLength(1);
        expect(result.allowedCatalog[0].id).toBe("gemini-2.5-flash");
      });

      it("should allow models from standard format", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-3-5-sonnet": { alias: "fast" },
              },
            },
          },
        };

        const catalog: ModelCatalogEntry[] = [
          {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
            name: "Claude 3.5 Sonnet",
          },
        ];

        const result = buildAllowedModelSet({
          cfg: cfg as OpenClawConfig,
          catalog,
          defaultProvider: "anthropic",
          defaultModel: "claude-3-5-sonnet",
        });

        expect(result.allowAny).toBe(false);
        expect(result.allowedKeys.has("anthropic/claude-3-5-sonnet")).toBe(true);
      });

      it("should handle mixed standard and inverted formats", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-3-5-sonnet": { alias: "fast" },
                flash: { alias: "google/gemini-2.5-flash" },
              },
            },
          },
        };

        const catalog: ModelCatalogEntry[] = [
          {
            provider: "anthropic",
            id: "claude-3-5-sonnet",
            name: "Claude 3.5 Sonnet",
          },
          { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ];

        const result = buildAllowedModelSet({
          cfg: cfg as OpenClawConfig,
          catalog,
          defaultProvider: "anthropic",
          defaultModel: "claude-3-5-sonnet",
        });

        expect(result.allowAny).toBe(false);
        expect(result.allowedKeys.has("anthropic/claude-3-5-sonnet")).toBe(true);
        expect(result.allowedKeys.has("google/gemini-2.5-flash")).toBe(true);
        expect(result.allowedCatalog).toHaveLength(2);
      });
    });

    describe("resolveModelRefFromString with inverted aliases", () => {
      it("should resolve inverted alias to correct model ref", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              models: {
                flash: { alias: "google/gemini-2.5-flash" },
              },
            },
          },
        };

        const index = buildModelAliasIndex({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "anthropic",
        });

        const resolved = resolveModelRefFromString({
          raw: "flash",
          defaultProvider: "anthropic",
          aliasIndex: index,
        });

        expect(resolved?.ref).toEqual({
          provider: "google",
          model: "gemini-2.5-flash",
        });
        expect(resolved?.alias).toBe("flash");
      });
    });
  });
});
