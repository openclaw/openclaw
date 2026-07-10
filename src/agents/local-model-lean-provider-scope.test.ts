import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { filterLocalModelLeanTools, isLocalModelLeanEnabled } from "./local-model-lean.js";

function configWithLeanEnabled(): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "main",
          model: "ollama/qwen3-coder",
          experimental: {
            localModelLean: true,
          },
        },
      ],
    },
  };
}

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

describe("local model lean provider scope", () => {
  it("does not treat a known hosted provider override as local", () => {
    const config = configWithLeanEnabled();
    const modelScope = {
      modelProvider: "meta",
      modelApi: "openai-completions",
      modelId: "muse-spark-1.1",
    } as const;

    expect(isLocalModelLeanEnabled({ config, agentId: "main", ...modelScope })).toBe(false);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config,
        agentId: "main",
        ...modelScope,
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("preserves lean behavior when no configured model establishes an override", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(
      isLocalModelLeanEnabled({
        config,
        agentId: "main",
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-test",
      }),
    ).toBe(true);
  });

  it("keeps arbitrary custom local OpenAI-compatible providers eligible", () => {
    const config: OpenClawConfig = {
      ...configWithLeanEnabled(),
      models: {
        providers: {
          "custom-local": {
            baseUrl: "http://192.168.1.25:1234/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };
    const modelScope = {
      modelProvider: "custom-local",
      modelApi: "openai-completions",
      modelId: "qwen3-coder",
    } as const;

    expect(isLocalModelLeanEnabled({ config, agentId: "main", ...modelScope })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config,
        agentId: "main",
        ...modelScope,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("prefers the resolved public endpoint over a configured private provider endpoint", () => {
    const config: OpenClawConfig = {
      ...configWithLeanEnabled(),
      models: {
        providers: {
          "custom-local": {
            baseUrl: "http://192.168.1.25:1234/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };

    expect(
      isLocalModelLeanEnabled({
        config,
        agentId: "main",
        modelProvider: "custom-local",
        modelApi: "openai-completions",
        modelBaseUrl: "https://models.example.com/v1",
        modelId: "qwen3-coder",
      }),
    ).toBe(false);
  });

  it("disables lean mode for configured custom hosted endpoints", () => {
    const config: OpenClawConfig = {
      ...configWithLeanEnabled(),
      models: {
        providers: {
          "custom-hosted": {
            baseUrl: "https://models.example.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };

    expect(
      isLocalModelLeanEnabled({
        config,
        agentId: "main",
        modelProvider: "custom-hosted",
        modelApi: "openai-completions",
        modelId: "hosted-model",
      }),
    ).toBe(false);
  });

  it.each(["minimax", "opencode", "opencode-go"])(
    "disables lean mode from the resolved hosted endpoint for %s",
    (modelProvider) => {
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

      expect(
        isLocalModelLeanEnabled({
          config,
          agentId: "main",
          modelProvider,
          modelBaseUrl: "https://models.example.com/v1",
          modelId: "hosted-model",
        }),
      ).toBe(false);
    },
  );

  it("keeps LM Studio eligible when only provider and model id are resolved", () => {
    const config = configWithLeanEnabled();
    const modelScope = {
      modelProvider: "lmstudio",
      modelId: "qwen3-coder",
    } as const;

    expect(isLocalModelLeanEnabled({ config, agentId: "main", ...modelScope })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config,
        agentId: "main",
        ...modelScope,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("preserves opt-in behavior for unknown providers without endpoint facts", () => {
    const config = configWithLeanEnabled();

    expect(
      isLocalModelLeanEnabled({
        config,
        agentId: "main",
        modelProvider: "custom-unresolved",
        modelApi: "openai-completions",
        modelId: "custom-model",
      }),
    ).toBe(true);
  });

  it("preserves legacy config-only resolution when model scope is unavailable", () => {
    const config = configWithLeanEnabled();

    expect(isLocalModelLeanEnabled({ config, agentId: "main" })).toBe(true);
  });
});
