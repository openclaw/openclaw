import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import {
  testing,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../tool-search.js";
import { createAgentHarnessToolSurfaceRuntime } from "./tool-surface-bridge.js";

function tools(names: string[]) {
  return names.map(createStubTool);
}

function createRuntime(
  config: OpenClawConfig,
  modelScope: { modelProvider?: string; modelBaseUrl?: string; modelId?: string } = {},
) {
  return createAgentHarnessToolSurfaceRuntime({
    config,
    executeTool: async () => ({ content: [], details: {} }),
    modelToolsEnabled: true,
    ...modelScope,
  });
}

describe("createAgentHarnessToolSurfaceRuntime", () => {
  it("filters raw SDK tools but does not refilter prepared constructor output", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { alsoAllow: ["image_generate"], toolSearch: { enabled: false } },
    };
    const runtime = createRuntime(config);

    expect(
      runtime
        .compactTools(tools(["read", "browser", "image_generate"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "image_generate"]);
    expect(
      runtime
        .compactTools(tools(["read", "browser"]), { localModelLeanApplied: true })
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "browser"]);
    runtime.cleanup();
  });

  it("keeps the full harness tool surface for hosted provider overrides", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "ollama/qwen3-coder",
          experimental: { localModelLean: true },
        },
      },
    };
    const runtime = createRuntime(config, {
      modelProvider: "meta",
      modelId: "muse-spark-1.1",
    });

    expect(runtime.toolSearchControlsEnabled).toBe(false);
    expect(
      runtime
        .compactTools(tools(["read", "browser", "cron", "message", "exec"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
    runtime.cleanup();
  });

  it("keeps the full harness surface for an unknown provider on a public endpoint", () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            model: "ollama/qwen3-coder",
            experimental: { localModelLean: true },
          },
        ],
      },
    };
    const runtime = createRuntime(config, {
      modelProvider: "custom-provider",
      modelBaseUrl: "https://models.example.com/v1",
      modelId: "hosted-model",
    });

    expect(runtime.toolSearchControlsEnabled).toBe(false);
    expect(
      runtime
        .compactTools(tools(["read", "browser", "cron", "message", "exec"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
    runtime.cleanup();
  });

  it("applies lean filtering for an unknown provider on a private endpoint", () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            model: "ollama/qwen3-coder",
            experimental: { localModelLean: true },
          },
        ],
      },
      tools: { toolSearch: { enabled: false } },
    };
    const runtime = createRuntime(config, {
      modelProvider: "custom-provider",
      modelBaseUrl: "http://192.168.1.50:1234/v1",
      modelId: "local-model",
    });

    expect(runtime.toolSearchControlsEnabled).toBe(false);
    expect(
      runtime
        .compactTools(tools(["read", "browser", "cron", "message", "exec"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
    runtime.cleanup();
  });

  it("still applies lean filtering for known local harness providers", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { toolSearch: { enabled: false } },
    };
    const runtime = createRuntime(config, {
      modelProvider: "lmstudio",
      modelId: "qwen3-coder",
    });

    expect(
      runtime
        .compactTools(tools(["read", "browser", "cron", "message", "exec"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
    runtime.cleanup();
  });

  it("keeps exec direct in lean structured Tool Search mode", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
    };
    const runtime = createRuntime(config);

    expect(
      runtime
        .compactTools(
          tools([
            TOOL_SEARCH_RAW_TOOL_NAME,
            TOOL_DESCRIBE_RAW_TOOL_NAME,
            TOOL_CALL_RAW_TOOL_NAME,
            "exec",
            "read",
          ]),
        )
        .tools.map((tool) => tool.name),
    ).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
      "exec",
    ]);
    runtime.cleanup();
  });

  it("preserves explicit code-mode compaction for lean runs", () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    try {
      const config: OpenClawConfig = {
        agents: { defaults: { experimental: { localModelLean: true } } },
        tools: { toolSearch: { mode: "code" } },
      };
      const runtime = createRuntime(config);

      expect(
        runtime
          .compactTools(tools([TOOL_SEARCH_CODE_MODE_TOOL_NAME, "exec", "read"]))
          .tools.map((tool) => tool.name),
      ).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
      runtime.cleanup();
    } finally {
      testing.setToolSearchCodeModeSupportedForTest(undefined);
    }
  });
});
