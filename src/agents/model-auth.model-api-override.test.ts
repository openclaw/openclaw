import { describe, it, expect } from "vitest";
import { resolveApiKeyForProvider } from "./model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

describe("model-level api override in auth resolution", () => {
  it("should resolve synthetic auth when model overrides api to ollama within openai-completions provider", async () => {
    // Scenario: Provider-level api is "openai-completions", model-level api is "ollama"
    // Expected: Should discover Ollama plugin's synthetic auth hooks
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "my-router": {
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
            models: [
              { id: "my-router/cloud-model", name: "Cloud Model" },
              { id: "my-router/local-llama", name: "Local Llama", api: "ollama", baseUrl: "http://localhost:11434" }
            ]
          }
        }
      },
      plugins: {
        allow: ["ollama"]
      }
    };

    // This should NOT throw "No API provider registered for api: ollama"
    // Instead, it should resolve synthetic auth via Ollama plugin
    const result = await resolveApiKeyForProvider({
      provider: "my-router",
      cfg,
      modelApi: "ollama" // Model-level override
    });

    // Verify: Should successfully resolve auth (not throw)
    expect(result).toBeDefined();
    expect(result.apiKey).toBeDefined();
    
    // Should come from Ollama synthetic auth (local marker or resolved auth)
    expect(result.source).toMatch(/ollama|synthetic|local/i);
  });

  it("should fallback to provider-level api when modelApi is not provided", async () => {
    // Scenario: No modelApi parameter, should use provider-level api
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "test-provider": {
            api: "ollama",
            baseUrl: "http://localhost:11434"
          }
        }
      },
      plugins: {
        allow: ["ollama"]
      }
    };

    const result = await resolveApiKeyForProvider({
      provider: "test-provider",
      cfg
      // No modelApi - should use provider-level "ollama"
    });

    expect(result).toBeDefined();
    expect(result.apiKey).toBeDefined();
  });
});