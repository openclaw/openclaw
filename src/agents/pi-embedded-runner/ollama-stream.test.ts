import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/config.js";
import {
  createOllamaAwareStreamFn,
  isOllamaProvider,
  shouldDisableStreamingForTools,
} from "./ollama-stream.js";

describe("isOllamaProvider", () => {
  it("should detect Ollama by port 11434 in baseUrl", () => {
    expect(
      isOllamaProvider({
        baseUrl: "http://localhost:11434/v1",
        provider: "custom",
        id: "test",
        api: "openai-completions",
      } as Parameters<typeof isOllamaProvider>[0]),
    ).toBe(true);
  });

  it("should detect Ollama by 127.0.0.1:11434 in baseUrl", () => {
    expect(
      isOllamaProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        provider: "custom",
        id: "test",
        api: "openai-completions",
      } as Parameters<typeof isOllamaProvider>[0]),
    ).toBe(true);
  });

  it("should detect Ollama by provider name", () => {
    expect(
      isOllamaProvider({
        baseUrl: "http://example.com/v1",
        provider: "ollama",
        id: "test",
        api: "openai-completions",
      } as Parameters<typeof isOllamaProvider>[0]),
    ).toBe(true);
  });

  it("should return false for non-Ollama providers", () => {
    expect(
      isOllamaProvider({
        baseUrl: "https://api.openai.com/v1",
        provider: "openai",
        id: "gpt-4",
        api: "openai-completions",
      } as Parameters<typeof isOllamaProvider>[0]),
    ).toBe(false);
  });
});

describe("shouldDisableStreamingForTools", () => {
  it("should return true when streamToolCalls is explicitly false", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [],
            streamToolCalls: false,
          },
        },
      },
    };
    expect(shouldDisableStreamingForTools({ cfg, provider: "ollama" })).toBe(true);
  });

  it("should return false when streamToolCalls is true", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [],
            streamToolCalls: true,
          },
        },
      },
    };
    expect(shouldDisableStreamingForTools({ cfg, provider: "ollama" })).toBe(false);
  });

  it("should return false when streamToolCalls is not set", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    expect(shouldDisableStreamingForTools({ cfg, provider: "openai" })).toBe(false);
  });

  it("should return false when provider is not in config", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {},
      },
    };
    expect(shouldDisableStreamingForTools({ cfg, provider: "unknown" })).toBe(false);
  });

  it("should return false when config is undefined", () => {
    expect(shouldDisableStreamingForTools({ cfg: undefined, provider: "ollama" })).toBe(false);
  });
});

describe("createOllamaAwareStreamFn", () => {
  it("should return underlying streamFn when streamToolCalls is not false", () => {
    const mockStreamFn = vi.fn();
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };

    const wrappedFn = createOllamaAwareStreamFn({
      cfg,
      provider: "openai",
      baseStreamFn: mockStreamFn,
    });

    // When streamToolCalls is not explicitly false, it should return the base function
    expect(wrappedFn).toBe(mockStreamFn);
  });

  it("should use underlying streamFn when no tools are present", () => {
    const mockStreamFn = vi.fn().mockReturnValue({ push: vi.fn(), end: vi.fn() });
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [],
            streamToolCalls: false,
          },
        },
      },
    };

    const wrappedFn = createOllamaAwareStreamFn({
      cfg,
      provider: "ollama",
      baseStreamFn: mockStreamFn,
    });

    const model = {
      provider: "ollama",
      id: "mistral",
      api: "openai-completions",
    };
    const context = {
      messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }],
      // No tools
    };

    void wrappedFn(model as Parameters<typeof wrappedFn>[0], context, {});

    // Should call the underlying stream function when no tools are present
    expect(mockStreamFn).toHaveBeenCalledWith(model, context, {});
  });
});
