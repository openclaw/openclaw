import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { installModelsConfigTestHooks, withModelsTempHome } from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

describe("models-config", () => {
  installModelsConfigTestHooks();

  it("normalizes gemini 3 ids to preview for google providers", async () => {
    await withModelsTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              apiKey: "GEMINI_KEY",
              api: "google-generative-ai",
              models: [
                {
                  id: "gemini-3-pro",
                  name: "Gemini 3 Pro",
                  api: "google-generative-ai",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
                {
                  id: "gemini-3-flash",
                  name: "Gemini 3 Flash",
                  api: "google-generative-ai",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const parsed = await readGeneratedModelsJson<{
        providers: Record<string, { models: Array<{ id: string }> }>;
      }>();
      const ids = parsed.providers.google?.models?.map((model) => model.id);
      expect(ids).toEqual(["gemini-3-pro-preview", "gemini-3-flash-preview"]);
    });
  });
});
