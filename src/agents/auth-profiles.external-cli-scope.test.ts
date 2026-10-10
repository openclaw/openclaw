import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExternalCliAuthScopeFromConfig } from "./auth-profiles/external-cli-scope.js";

describe("external CLI auth scope", () => {
  it("returns undefined without a provider signal", () => {
    expect(resolveExternalCliAuthScopeFromConfig({})).toBeUndefined();
  });

  it("collects configured credentials, models, and runtime providers without treating aliases as active", () => {
    const cfg = {
      auth: {
        profiles: { "opencode-go:default": { provider: "opencode-go", mode: "api_key" } },
        order: { openai: ["openai:default"] },
      },
      models: {
        providers: {
          "opencode-go": { baseUrl: "https://example.test/v1", auth: "api-key", models: [] },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7", fallbacks: ["openai/gpt-5.5"] },
          mediaModels: { image: "minimax-portal/image-01" },
          voiceModel: "elevenlabs/eleven_multilingual_v2",
          models: {
            "claude-cli/claude-opus-4-7": { alias: "opus" },
            "google/gemini-3.1-pro-preview": { agentRuntime: { id: "google-gemini-cli" } },
          },
        },
        entries: {
          worker: {
            model: "opencode-go/kimi-k2.6",
            models: { "opencode-go/kimi-k2.6": { agentRuntime: { id: "codex-app-server" } } },
            subagents: { model: { primary: "z.ai/glm-4.7" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    expect(resolveExternalCliAuthScopeFromConfig(cfg)).toEqual({
      providerIds: [
        "anthropic",
        "codex-app-server",
        "elevenlabs",
        "google-gemini-cli",
        "minimax-portal",
        "openai",
        "opencode-go",
        "z.ai",
      ],
      profileIds: ["openai:default", "opencode-go:default"],
    });
  });
});
