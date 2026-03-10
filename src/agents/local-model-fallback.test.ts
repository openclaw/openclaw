/**
 * Tests for Local Model Fallback Layer
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveLocalModelConfig,
  shouldTriggerLocalFallback,
  cosineSimilarity,
  type LocalFallbackOptions,
} from "./local-model-fallback.js";

describe("Local Model Fallback", () => {
  describe("resolveLocalModelConfig", () => {
    it("should return null when local model fallback is not enabled", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            localModelFallback: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveLocalModelConfig(cfg);
      expect(result).toBeNull();
    });

    it("should return null when local model fallback config is missing", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {},
        },
      } as OpenClawConfig;

      const result = resolveLocalModelConfig(cfg);
      expect(result).toBeNull();
    });

    it("should resolve Ollama config with defaults", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            localModelFallback: {
              enabled: true,
              provider: "ollama",
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveLocalModelConfig(cfg);
      expect(result).not.toBeNull();
      expect(result?.provider).toBe("ollama");
      expect(result?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(result?.model).toBe("llama3.2");
      expect(result?.enabled).toBe(true);
    });

    it("should resolve LM Studio config with defaults", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            localModelFallback: {
              enabled: true,
              provider: "lmstudio",
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveLocalModelConfig(cfg);
      expect(result).not.toBeNull();
      expect(result?.provider).toBe("lmstudio");
      expect(result?.baseUrl).toBe("http://127.0.0.1:1234");
    });

    it("should use custom configuration values", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            localModelFallback: {
              enabled: true,
              provider: "ollama",
              baseUrl: "http://custom:11434",
              model: "custom-model",
              apiKey: "test-key",
              timeoutMs: 30000,
              healthCheckIntervalMs: 15000,
              maxRetries: 5,
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveLocalModelConfig(cfg);
      expect(result?.baseUrl).toBe("http://custom:11434");
      expect(result?.model).toBe("custom-model");
      expect(result?.apiKey).toBe("test-key");
      expect(result?.timeoutMs).toBe(30000);
      expect(result?.healthCheckIntervalMs).toBe(15000);
      expect(result?.maxRetries).toBe(5);
    });
  });

  describe("shouldTriggerLocalFallback", () => {
    const defaultOptions: LocalFallbackOptions = {
      triggerStatusCodes: [429, 503, 502, 500],
      triggerOnTimeout: true,
      triggerOnRateLimit: true,
      minConsecutiveFailures: 1,
    };

    it("should not trigger fallback when consecutive failures are below minimum", () => {
      const error = new Error("Test error");
      const result = shouldTriggerLocalFallback(error, defaultOptions, 0);
      expect(result).toBe(false);
    });

    it("should trigger fallback on rate limit error", () => {
      const error = { status: 429, reason: "rate_limit" };
      const result = shouldTriggerLocalFallback(error, defaultOptions, 1);
      expect(result).toBe(true);
    });

    it("should trigger fallback on server error", () => {
      const error = { status: 503 };
      const result = shouldTriggerLocalFallback(error, defaultOptions, 1);
      expect(result).toBe(true);
    });

    it("should not trigger fallback on non-trigger status codes", () => {
      const error = { status: 404 };
      const result = shouldTriggerLocalFallback(error, defaultOptions, 1);
      expect(result).toBe(false);
    });
  });

  describe("cosineSimilarity", () => {
    it("should calculate perfect similarity for identical vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(1, 5);
    });

    it("should calculate zero similarity for orthogonal vectors", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0, 5);
    });

    it("should throw error for mismatched dimensions", () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      expect(() => cosineSimilarity(a, b)).toThrow("Vector dimension mismatch");
    });
  });
});
