import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { describeOpenClawGenerationToolRegistration } from "./openclaw-tools.generation.test-support.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveImageModelConfigForTool } from "./tools/image-tool.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describeOpenClawGenerationToolRegistration({
  suiteName: "openclaw tools image generation registration",
  toolName: "image_generate",
  toolLabel: "an image-generation tool",
});

describe("openclaw tools image registration", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
    vi.stubEnv("MINIMAX_OAUTH_TOKEN", "");
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("Z_AI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers image when the current runtime model is vision-capable", () => {
    const agentDir = "/tmp/openclaw-agent-main";
    const config = asConfig({
      agents: {
        defaults: {
          model: {
            primary: "opencode-go/minimax-m2.7",
          },
        },
      },
    });

    expect(resolveImageModelConfigForTool({ cfg: config, agentDir })).toBeNull();

    const tools = createOpenClawTools({
      config,
      agentDir,
      disablePluginTools: true,
      modelHasVision: true,
      modelProvider: "opencode-go",
      modelId: "minimax-m2.7",
    });

    expect(tools.map((tool) => tool.name)).toContain("image");
  });
});
