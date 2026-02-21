import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureOpenClawModelsJson } from "./models-config.js";

describe("ensureOpenClawModelsJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves existing models when new provider config has no models array", async () => {
    // Scenario: models.json has qwen-portal with both coder-model and vision-model.
    // When ensureOpenClawModelsJson runs with a config that has qwen-portal
    // but without a models array (e.g., auth profiles inaccessible), the existing
    // models should be preserved.
    //
    // This tests the fix for: https://github.com/openclaw/openclaw/issues/9291

    const agentDir = path.join(tmpDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });

    // Create existing models.json with both models
    const existingModelsJson = {
      providers: {
        "qwen-portal": {
          baseUrl: "https://portal.qwen.ai/v1",
          apiKey: "qwen-oauth",
          api: "openai-completions",
          models: [
            {
              id: "coder-model",
              name: "Qwen Coder",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
            {
              id: "vision-model",
              name: "Qwen Vision",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(existingModelsJson, null, 2),
    );

    // Do NOT create auth.json - this ensures resolveImplicitProviders() won't return
    // qwen-portal with models, so the only source is the explicit config without models.

    // Run ensureOpenClawModelsJson with a config that has qwen-portal
    // but WITHOUT models array (simulates when auth profiles aren't accessible
    // and buildQwenPortalProvider isn't included in implicit providers)
    const cfg = {
      models: {
        mode: "merge" as const,
        providers: {
          "qwen-portal": {
            baseUrl: "https://portal.qwen.ai/v1",
            apiKey: "qwen-oauth",
            api: "openai-completions",
            // Note: no models array - this simulates the scenario where
            // implicit providers don't include qwen-portal (no auth profiles)
            // and explicit config doesn't have models
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfg, agentDir);

    // Read the updated models.json
    const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as typeof existingModelsJson;

    // Both models should be preserved
    const qwenPortal = parsed.providers["qwen-portal"];
    expect(qwenPortal).toBeDefined();
    expect(qwenPortal.models).toBeDefined();
    expect(Array.isArray(qwenPortal.models)).toBe(true);
    expect(qwenPortal.models.length).toBe(2);

    const modelIds = qwenPortal.models.map((m: { id: string }) => m.id);
    expect(modelIds).toContain("coder-model");
    expect(modelIds).toContain("vision-model");
  });

  it("preserves vision-model when new config only has coder-model", async () => {
    // Scenario: User has both models, but new config explicitly only has coder-model.
    // The vision-model from existing should be preserved (merged).

    const agentDir = path.join(tmpDir, "agent2");
    await fs.mkdir(agentDir, { recursive: true });

    // Create existing models.json with both models
    const existingModelsJson = {
      providers: {
        "qwen-portal": {
          baseUrl: "https://portal.qwen.ai/v1",
          apiKey: "qwen-oauth",
          api: "openai-completions",
          models: [
            {
              id: "coder-model",
              name: "Qwen Coder",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
            {
              id: "vision-model",
              name: "Qwen Vision",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(existingModelsJson, null, 2),
    );

    // Do NOT create auth.json - ensures implicit providers won't include qwen-portal.

    // Config with only coder-model
    const cfg = {
      models: {
        mode: "merge" as const,
        providers: {
          "qwen-portal": {
            baseUrl: "https://portal.qwen.ai/v1",
            apiKey: "qwen-oauth",
            api: "openai-completions",
            models: [
              {
                id: "coder-model",
                name: "Qwen Coder Updated",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfg, agentDir);

    // Read the updated models.json
    const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as typeof existingModelsJson;

    // Both models should be present (coder-model from new config, vision-model from existing)
    const qwenPortal = parsed.providers["qwen-portal"];
    expect(qwenPortal.models.length).toBe(2);

    const modelIds = qwenPortal.models.map((m: { id: string }) => m.id);
    expect(modelIds).toContain("coder-model");
    expect(modelIds).toContain("vision-model");

    // coder-model should have the updated name from new config
    const coderModel = qwenPortal.models.find((m: { id: string }) => m.id === "coder-model") as {
      name: string;
    };
    expect(coderModel.name).toBe("Qwen Coder Updated");
  });
});
