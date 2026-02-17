import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  parseModelRef,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
  buildModelAliasIndex,
  normalizeProviderId,
  modelKey,
  resolveModelForTaskIntent,
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
    it("should use defaultProvider when provider is missing (not anthropic)", () => {
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

      // Should use the configured defaultProvider, not always fall back to anthropic
      expect(result).toEqual({ provider: "google", model: "claude-3-5-sonnet" });
      expect(warnSpy).not.toHaveBeenCalled(); // No warning when defaultProvider is not anthropic
      warnSpy.mockRestore();
    });

    it("should warn when falling back to anthropic as defaultProvider", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            model: "claude-3-5-sonnet",
          },
        },
      };

      const result = resolveConfiguredModelRef({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
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

  describe("resolveModelForTaskIntent - routing precedence", () => {
    describe("BUG #1: codingModel should respect complexity routing", () => {
      it("should use complexity routing BEFORE codingModel for coding tasks", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              codingModel: { primary: "anthropic/claude-opus-4-5" },
              modelByComplexity: {
                enabled: true,
                trivial: "openai/gpt-4o-mini",
                moderate: "anthropic/claude-sonnet-4-5",
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        // For complex coding task, should use complexity routing (gemini thinking)
        // NOT codingModel (opus)
        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "coding",
          complexity: "complex",
        });

        expect(result.ref).toEqual({
          provider: "google",
          model: "gemini-2.0-flash-thinking-exp",
        });
        expect(result.reason).toBe("complexity");
      });

      it("should fall back to codingModel when complexity slot is empty", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              codingModel: { primary: "anthropic/claude-opus-4-5" },
              modelByComplexity: {
                enabled: true,
                trivial: "openai/gpt-4o-mini",
                moderate: "", // Empty moderate slot
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        // For moderate coding task with empty complexity slot,
        // should fall back to codingModel
        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "coding",
          complexity: "moderate",
        });

        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
        expect(result.reason).toBe("taskType");
      });
    });

    describe("BUG #2: autoPickFromPool should NOT disable complexity routing", () => {
      it("should apply complexity routing when autoPickFromPool=false", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              modelByComplexity: {
                enabled: true,
                autoPickFromPool: false, // User explicitly picked a model in UI
                trivial: "openai/gpt-4o-mini",
                moderate: "anthropic/claude-sonnet-4-5",
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        // Complexity routing should still work for reasoning tasks
        // even when autoPickFromPool=false
        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "reasoning",
          complexity: "complex",
        });

        expect(result.ref).toEqual({
          provider: "google",
          model: "gemini-2.0-flash-thinking-exp",
        });
        expect(result.reason).toBe("complexity");
      });

      it("should apply complexity routing for conversation tasks when autoPickFromPool=false", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              modelByComplexity: {
                autoPickFromPool: false,
                trivial: "openai/gpt-4o-mini",
                moderate: "anthropic/claude-sonnet-4-5",
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        // Complexity routing auto-enables when slots are configured
        const resultTrivial = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "conversation",
          complexity: "trivial",
        });

        expect(resultTrivial.ref).toEqual({ provider: "openai", model: "gpt-4o-mini" });
        expect(resultTrivial.reason).toBe("complexity");
      });
    });

    describe("Complexity routing enablement logic", () => {
      it("should auto-enable when any complexity slot is configured", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              modelByComplexity: {
                // enabled not explicitly set
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "reasoning",
          complexity: "complex",
        });

        expect(result.ref).toEqual({
          provider: "google",
          model: "gemini-2.0-flash-thinking-exp",
        });
        expect(result.reason).toBe("complexity");
      });

      it("should respect explicit enabled=false", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              codingModel: { primary: "anthropic/claude-opus-4-5" },
              modelByComplexity: {
                enabled: false, // Explicitly disabled
                complex: "google/gemini-2.0-flash-thinking-exp",
              },
            },
          },
        };

        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "coding",
          complexity: "complex",
        });

        // Should fall back to codingModel, not use complexity routing
        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
        expect(result.reason).toBe("taskType");
      });
    });

    describe("Vision task special handling", () => {
      it("should check imageModel BEFORE complexity routing", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              imageModel: { primary: "anthropic/claude-opus-4-5" },
              modelByComplexity: {
                enabled: true,
                complex: "google/gemini-2.0-flash-thinking-exp", // text-only model
              },
            },
          },
        };

        // Vision task should use imageModel even if complexity routing exists
        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "vision",
          complexity: "complex",
        });

        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
        expect(result.reason).toBe("taskType");
      });

      it("should fall through to complexity routing if no imageModel configured", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              // No imageModel configured
              modelByComplexity: {
                enabled: true,
                complex: "anthropic/claude-opus-4-5", // vision-capable model
              },
            },
          },
        };

        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "vision",
          complexity: "complex",
        });

        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
        expect(result.reason).toBe("complexity");
      });
    });

    describe("Backward compatibility", () => {
      it("should preserve legacy behavior when no complexity routing configured", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
              codingModel: { primary: "anthropic/claude-opus-4-5" },
            },
          },
        };

        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "coding",
          complexity: "complex",
        });

        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
        expect(result.reason).toBe("taskType");
      });

      it("should use default model when no specialized config exists", () => {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-5" },
            },
          },
        };

        const result = resolveModelForTaskIntent({
          cfg: cfg as OpenClawConfig,
          taskType: "reasoning",
          complexity: "moderate",
        });

        expect(result.ref).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
        expect(result.reason).toBe("default");
      });
    });
  });
});
