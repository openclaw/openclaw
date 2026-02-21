import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { normalizeProviderApi } from "./models-config.providers.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-antigravity-" });
}

describe("normalizeProviderApi", () => {
  it("corrects google-gemini-cli to google-antigravity for google-antigravity provider", () => {
    expect(normalizeProviderApi("google-antigravity", "google-gemini-cli")).toBe(
      "google-antigravity",
    );
  });

  it("preserves google-antigravity when already correct", () => {
    expect(normalizeProviderApi("google-antigravity", "google-antigravity")).toBe(
      "google-antigravity",
    );
  });

  it("normalizes case and separator variants for antigravity provider and api keys", () => {
    expect(normalizeProviderApi("Google_Antigravity", "GOOGLE GEMINI CLI")).toBe(
      "google-antigravity",
    );
    expect(normalizeProviderApi("google antigravity", "google_antigravity")).toBe(
      "google-antigravity",
    );
  });

  it("preserves unknown api keys for antigravity provider", () => {
    expect(normalizeProviderApi("google-antigravity", "custom-api")).toBe("custom-api");
  });

  it("returns undefined when api is undefined", () => {
    expect(normalizeProviderApi("google-antigravity", undefined)).toBeUndefined();
  });

  it("does not modify api for non-Google providers", () => {
    expect(normalizeProviderApi("anthropic", "anthropic-messages")).toBe("anthropic-messages");
    expect(normalizeProviderApi("openai", "openai-completions")).toBe("openai-completions");
    expect(normalizeProviderApi("minimax", "openai-completions")).toBe("openai-completions");
  });

  it("does not modify api for google-gemini-cli provider", () => {
    expect(normalizeProviderApi("google-gemini-cli", "google-gemini-cli")).toBe(
      "google-gemini-cli",
    );
  });

  it("does not modify api for google provider", () => {
    expect(normalizeProviderApi("google", "google-generative-ai")).toBe("google-generative-ai");
  });
});

describe("models-config normalizes google-antigravity api", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("normalizes api from google-gemini-cli to google-antigravity for google-antigravity provider", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "google-antigravity": {
              baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
              apiKey: "google-antigravity-oauth",
              api: "google-gemini-cli", // Incorrect - should be normalized
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers["google-antigravity"]?.api).toBe("google-antigravity");
    });
  });

  it("preserves correct api value when already set to google-antigravity", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "google-antigravity": {
              baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
              apiKey: "google-antigravity-oauth",
              api: "google-antigravity", // Already correct
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers["google-antigravity"]?.api).toBe("google-antigravity");
    });
  });

  it("normalizes api for antigravity provider key aliases", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            Google_Antigravity: {
              baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
              apiKey: "google-antigravity-oauth",
              api: "GOOGLE GEMINI CLI",
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers.Google_Antigravity?.api).toBe("google-antigravity");
    });
  });

  it("normalizes whitespace-padded antigravity provider keys", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            " google-antigravity ": {
              baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
              apiKey: "google-antigravity-oauth",
              api: "google-gemini-cli",
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers["google-antigravity"]?.api).toBe("google-antigravity");
      expect(parsed.providers[" google-antigravity "]).toBeUndefined();
    });
  });

  it("prefers canonical antigravity provider key on normalized-key collisions", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "google-antigravity": {
              baseUrl: "https://canonical.example.com",
              apiKey: "canonical-key",
              api: "google-antigravity",
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
            " google-antigravity ": {
              baseUrl: "https://alias.example.com",
              apiKey: "alias-key",
              api: "google-gemini-cli",
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string; apiKey?: string; baseUrl?: string }>;
      };

      expect(parsed.providers["google-antigravity"]?.api).toBe("google-antigravity");
      expect(parsed.providers["google-antigravity"]?.apiKey).toBe("canonical-key");
      expect(parsed.providers["google-antigravity"]?.baseUrl).toBe("https://canonical.example.com");
      expect(parsed.providers[" google-antigravity "]).toBeUndefined();
    });
  });

  it("preserves unknown api values for antigravity provider", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "google-antigravity": {
              baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
              apiKey: "google-antigravity-oauth",
              api: "custom-api",
              models: [
                {
                  id: "claude-opus-4-6-thinking",
                  name: "Claude Opus 4.6 Thinking",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers["google-antigravity"]?.api).toBe("custom-api");
    });
  });

  it("does not modify api for other providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureOpenClawModelsJson } = await import("./models-config.js");
      const { resolveOpenClawAgentDir } = await import("./agent-paths.js");

      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "custom-proxy": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "TEST_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { api?: string }>;
      };

      expect(parsed.providers["custom-proxy"]?.api).toBe("openai-completions");
    });
  });
});
