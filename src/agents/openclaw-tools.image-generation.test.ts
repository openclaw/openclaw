import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as imageGenerationRuntime from "../image-generation/runtime.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveImageModelConfigForTool } from "./tools/image-tool.js";

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  copyPluginToolMeta: () => undefined,
  getPluginToolMeta: () => undefined,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      capabilities: {
        generate: {
          supportsSize: true,
        },
        edit: {
          enabled: false,
        },
        geometry: {
          sizes: ["1024x1024"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("openclaw tools image generation registration", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers image_generate when image-generation config is present", () => {
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
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    const tools = createOpenClawTools({
      config: asConfig({}),
      agentDir: "/tmp/openclaw-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("omits image_generate when config is absent and no compatible provider auth exists", () => {
    stubImageGenerationProviders();

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
