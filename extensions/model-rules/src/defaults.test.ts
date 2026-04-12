import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS_MD, ensureDefaultModelsFile } from "./defaults.js";

describe("DEFAULT_MODELS_MD", () => {
  it("contains the expected model headings", () => {
    const expectedModels = [
      "gpt-5.3",
      "gpt-5.4",
      "claude-sonnet-4-6",
      "gemini-2.5-pro",
      "deepseek-r1",
      "qwen3.6-plus",
      "kimi-k2.5",
      "MiniMax-M2.5",
      "gemma-4-31b-it",
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
