import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeProviders } from "./models-config.providers.js";

describe("normalizeProviders", () => {
  it("trims provider keys so image models remain discoverable for custom providers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        " dashscope-vision ": {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "DASHSCOPE_API_KEY",
          models: [
            {
              id: "qwen-vl-max",
              name: "Qwen VL Max",
              input: ["text", "image"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["dashscope-vision"]);
      expect(normalized?.["dashscope-vision"]?.models?.[0]?.id).toBe("qwen-vl-max");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "OPENAI_API_KEY",
          models: [],
        },
        " openai ": {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          apiKey: "CUSTOM_OPENAI_API_KEY",
          models: [
            {
              id: "gpt-4.1-mini",
              name: "GPT-4.1 mini",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
      expect(normalized?.openai?.baseUrl).toBe("https://example.com/v1");
      expect(normalized?.openai?.apiKey).toBe("CUSTOM_OPENAI_API_KEY");
      expect(normalized?.openai?.models?.[0]?.id).toBe("gpt-4.1-mini");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-value-12345";
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          apiKey: "sk-test-secret-value-12345", // simulates resolved ${OPENAI_API_KEY}
          api: "openai-completions",
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      };
      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.openai?.apiKey).toBe("OPENAI_API_KEY");
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
