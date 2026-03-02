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
});
