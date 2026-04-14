import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileCache } from "./parser.js";

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, string | undefined>,
) => Promise<{ appendSystemContext: string } | undefined>;

function createMockApi(config: Record<string, unknown> = {}) {
  const hooks = new Map<string, HookHandler>();
  return {
    api: {
      pluginConfig: config,
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      },
      on(hookName: string, handler: HookHandler) {
        hooks.set(hookName, handler);
      },
    },
    hooks,
  };
}

async function registerAndGetHook(config: Record<string, unknown> = {}): Promise<HookHandler> {
  const { api, hooks } = createMockApi(config);
  const entry = (await import("./index.js")).default;
  entry.register(api as never);
  const hook = hooks.get("before_prompt_build");
  if (!hook) {
    throw new Error("before_prompt_build hook was not registered");
  }
  return hook;
}

describe("model-rules hook behavior", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetFileCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-rules-hook-"));
  });

  afterEach(async () => {
    resetFileCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when workspaceDir is missing", async () => {
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: undefined, modelId: "gpt-5.4" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when modelId is missing", async () => {
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: tmpDir, modelId: undefined });
    expect(result).toBeUndefined();
  });

  it("injects appendSystemContext for a matched model", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MODELS.md"),
      "## MODEL: gpt-5.4\n\nDo not hallucinate.\n",
    );
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeDefined();
    expect(result!.appendSystemContext).toContain("Do not hallucinate.");
    expect(result!.appendSystemContext).toContain("[Corrective behavioral rules for gpt-5.4]");
  });

  it("returns undefined when no section matches", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\nRules.\n");
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "nonexistent" });
    expect(result).toBeUndefined();
  });

  it("skips placeholder sections", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\n[paste rules here]\n");
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeUndefined();
  });

  it("skips placeholder sections case-insensitively", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\n[Paste Rules Here]\n");
    const hook = await registerAndGetHook();
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeUndefined();
  });

  it("constructs full modelRef from modelProviderId + modelId", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MODELS.md"),
      "## MODEL: openai/gpt-5.4\n\nFull ref rules.\n\n## MODEL: gpt-5.4\n\nBare rules.\n",
    );
    const hook = await registerAndGetHook();
    const result = await hook(
      {},
      { workspaceDir: tmpDir, modelId: "gpt-5.4", modelProviderId: "openai" },
    );
    expect(result).toBeDefined();
    expect(result!.appendSystemContext).toContain("Full ref rules.");
  });

  it("disabledModels skips bare model id", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\nRules.\n");
    const hook = await registerAndGetHook({ disabledModels: ["gpt-5.4"] });
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeUndefined();
  });

  it("disabledModels is case-insensitive", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: GPT-5.4\n\nRules.\n");
    const hook = await registerAndGetHook({ disabledModels: ["gpt-5.4"] });
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "GPT-5.4" });
    expect(result).toBeUndefined();
  });

  it("disabledModels trims whitespace from entries", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\nRules.\n");
    const hook = await registerAndGetHook({ disabledModels: ["  gpt-5.4  "] });
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeUndefined();
  });

  it("disabledModels matches full ref form", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\nRules.\n");
    const hook = await registerAndGetHook({ disabledModels: ["openai/gpt-5.4"] });
    const result = await hook(
      {},
      { workspaceDir: tmpDir, modelId: "gpt-5.4", modelProviderId: "openai" },
    );
    expect(result).toBeUndefined();
  });

  it("does not inject when plugin is disabled", async () => {
    await fs.writeFile(path.join(tmpDir, "MODELS.md"), "## MODEL: gpt-5.4\n\nRules.\n");
    const { api, hooks } = createMockApi({ enabled: false });
    const entry = (await import("./index.js")).default;
    entry.register(api as never);
    expect(hooks.has("before_prompt_build")).toBe(false);
  });

  it("falls back to MODELS.md when modelsFile is blank", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MODELS.md"),
      "## MODEL: gpt-5.4\n\nDefault file rules.\n",
    );
    const hook = await registerAndGetHook({ modelsFile: "" });
    const result = await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    expect(result).toBeDefined();
    expect(result!.appendSystemContext).toContain("Default file rules.");
  });

  it("seeds default MODELS.md when file does not exist", async () => {
    const hook = await registerAndGetHook();
    await hook({}, { workspaceDir: tmpDir, modelId: "gpt-5.4" });
    const content = await fs.readFile(path.join(tmpDir, "MODELS.md"), "utf-8");
    expect(content).toContain("## MODEL: gpt-5.4");
  });
});
