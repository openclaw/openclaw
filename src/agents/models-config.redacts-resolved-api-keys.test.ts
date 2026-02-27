import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

const MODEL_ENTRY = {
  id: "test-model",
  name: "Test Model",
  reasoning: false,
  input: ["text"] as Array<"text" | "image">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};

describe("models-config secret redaction", () => {
  it("redacts resolved API key with REDACTED placeholder", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-proxy": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "sk-ant-secret-key-abc123",
              api: "openai-completions",
              models: [MODEL_ENTRY],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      expect(parsed.providers["custom-proxy"]).toBeDefined();
      expect(parsed.providers["custom-proxy"].apiKey).not.toBe("sk-ant-secret-key-abc123");
      expect(parsed.providers["custom-proxy"].apiKey).toBe("REDACTED");
    });
  });

  it("preserves env var name references (uppercase pattern)", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-proxy": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "CUSTOM_PROXY_API_KEY",
              api: "openai-completions",
              models: [MODEL_ENTRY],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      expect(parsed.providers["custom-proxy"]).toBeDefined();
      expect(parsed.providers["custom-proxy"].apiKey).toBe("CUSTOM_PROXY_API_KEY");
    });
  });

  it("preserves other provider fields (baseUrl, models, api)", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-proxy": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "sk-secret-key-should-be-redacted",
              api: "openai-completions",
              models: [MODEL_ENTRY],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { baseUrl?: string; api?: string; models?: unknown[] }>;
      }>();
      const provider = parsed.providers["custom-proxy"];
      expect(provider.baseUrl).toBe("http://localhost:4000/v1");
      expect(provider.api).toBe("openai-completions");
      expect(provider.models).toBeDefined();
      expect(provider.models).toHaveLength(1);
    });
  });

  it("handles empty string apiKey without crashing", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-proxy": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "",
              api: "openai-completions",
              models: [MODEL_ENTRY],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      // Empty string is not a resolved secret — should be preserved as-is
      expect(parsed.providers["custom-proxy"]).toBeDefined();
    });
  });

  it("redacts various secret key formats", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "openai-like": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "sk-proj-abc123def456",
              api: "openai-completions",
              models: [MODEL_ENTRY],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { apiKey?: string }>;
      }>();
      expect(parsed.providers["openai-like"].apiKey).toBe("REDACTED");
    });
  });
});
