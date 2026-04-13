import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS_MD, ensureDefaultModelsFile } from "./defaults.js";

describe("DEFAULT_MODELS_MD", () => {
  it("contains the expected model headings", () => {
    const expectedModels = [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-pro",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.3-chat",
      "claude-opus-4-6",
      "claude-opus-4-6-fast",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "kimi-k2.5",
      "qwen3.6-plus",
      "qwen3.5-397b-a17b",
      "qwen3.5-plus-02-15",
      "minimax-m2.5",
      "minimax-m2.7",
      "gemma-4-31b-it",
      "gemma-4-26b-a4b-it",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.1-pro-preview",
      "glm-5.1",
      "deepseek-r1",
      "deepseek-chat",
      "grok-4.20",
      "grok-4.20-reasoning",
      "grok-3",
      "llama-4-maverick",
    ];
    for (const model of expectedModels) {
      expect(DEFAULT_MODELS_MD).toContain(`## MODEL: ${model}`);
    }
  });

  it("includes self-documenting instructions for adding custom models", () => {
    expect(DEFAULT_MODELS_MD).toContain("Add your own models");
    expect(DEFAULT_MODELS_MD).toContain("local (Ollama, vLLM)");
  });
});

describe("ensureDefaultModelsFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-defaults-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates MODELS.md when it does not exist", async () => {
    const created = await ensureDefaultModelsFile(tmpDir);
    expect(created).toBe(true);

    const content = await fs.readFile(path.join(tmpDir, "MODELS.md"), "utf-8");
    expect(content).toBe(DEFAULT_MODELS_MD);
  });

  it("does not overwrite an existing file", async () => {
    const filePath = path.join(tmpDir, "MODELS.md");
    await fs.writeFile(filePath, "custom content");

    const created = await ensureDefaultModelsFile(tmpDir);
    expect(created).toBe(false);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("custom content");
  });

  it("supports a custom filename", async () => {
    const created = await ensureDefaultModelsFile(tmpDir, "RULES.md");
    expect(created).toBe(true);

    const content = await fs.readFile(path.join(tmpDir, "RULES.md"), "utf-8");
    expect(content).toBe(DEFAULT_MODELS_MD);
  });
});
