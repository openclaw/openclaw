import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveImageModelConfigForTool } from "./tools/image-tool.js";

const hoisted = vi.hoisted(() => ({
  createImageGenerateTool: vi.fn(),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  copyPluginToolMeta: () => undefined,
  getPluginToolMeta: () => undefined,
}));

vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: (...args: unknown[]) => hoisted.createImageGenerateTool(...args),
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("openclaw tools image generation registration", () => {
  afterEach(() => {
    hoisted.createImageGenerateTool.mockReset();
  });

  it("registers image_generate when image-generation config is present", () => {
    hoisted.createImageGenerateTool.mockReturnValue({
      name: "image_generate",
      description: "image fixture tool",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
        };
      },
    });

    const tools = createOpenClawTools({
      config: asConfig({
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      }),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("registers image_generate when a compatible provider has env-backed auth", () => {
    hoisted.createImageGenerateTool.mockReturnValue({
      name: "image_generate",
      description: "image fixture tool",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
        };
      },
    });

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("omits image_generate when config is absent and no compatible provider auth exists", () => {
    hoisted.createImageGenerateTool.mockReturnValue(null);

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("image_generate");
  });
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
      modelHasVision: true,
      modelProvider: "opencode-go",
      modelId: "minimax-m2.7",
    });

    expect(tools.map((tool) => tool.name)).toContain("image");
  });
});
