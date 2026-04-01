import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";

type Providers = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

function buildGoogleProvider(overrides: Partial<Providers[string]> = {}): Providers[string] {
  return {
    baseUrl: "https://generativelanguage.googleapis.com",
    api: "google-generative-ai",
    apiKey: "GEMINI_API_KEY", // pragma: allowlist secret
    models: [
      {
        id: "gemini-3.1-flash-lite-preview",
        name: "Gemini 3.1 Flash Lite",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
    ...overrides,
  };
}

describe("normalizeProviders google baseUrl", () => {
  it("appends /v1beta to bare googleapis.com baseUrl for custom provider keys", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: Providers = {
        "my-paid-google": buildGoogleProvider(),
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.["my-paid-google"]?.baseUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta",
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not double-append /v1beta when already present", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: Providers = {
        "my-paid-google": buildGoogleProvider({
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.["my-paid-google"]?.baseUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta",
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves non-googleapis base URLs unchanged", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: Providers = {
        "my-proxy": buildGoogleProvider({
          baseUrl: "https://my-proxy.example.com/gemini",
        }),
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.["my-proxy"]?.baseUrl).toBe("https://my-proxy.example.com/gemini");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("normalizes when api is declared on individual models", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: Providers = {
        "custom-google": {
          baseUrl: "https://generativelanguage.googleapis.com",
          apiKey: "GEMINI_API_KEY", // pragma: allowlist secret
          models: [
            {
              id: "gemini-3.1-flash-lite-preview",
              name: "Gemini 3.1 Flash Lite",
              api: "google-generative-ai",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.["custom-google"]?.baseUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta",
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
