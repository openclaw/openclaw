import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAcpSpawnAgentEnv } from "./acp-spawn-agent-env.js";

function makeConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveAcpSpawnAgentEnv", () => {
  it("returns undefined when agent has no model configured", () => {
    const cfg = makeConfig({});
    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "test-agent" });
    expect(result).toBeUndefined();
  });

  it("resolves env vars for agent with explicit provider/model", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "openai/gpt-5" }],
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-agent-specific-key",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeDefined();
    expect(result!.OPENAI_API_KEY).toBe("sk-agent-specific-key");
  });

  it("resolves via agents.defaults.model when agent has no explicit model", () => {
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-default-key",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "any-agent" });
    expect(result).toBeDefined();
    expect(result!.OPENAI_API_KEY).toBe("sk-default-key");
  });

  it("defaults to anthropic provider for bare model name", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "claude-opus-4-6" }],
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            apiKey: "sk-ant-key",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeDefined();
    // Anthropic has multiple candidates: ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_API_KEY
    expect(result!.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(result!.ANTHROPIC_OAUTH_TOKEN).toBe("sk-ant-key");
  });

  it("returns undefined when API key is a non-secret marker", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "ollama/llama3" }],
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            apiKey: "ollama-local",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when provider has no API key configured", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "openai/gpt-5" }],
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeUndefined();
  });

  it("includes baseUrl when provider has one configured", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "openai/gpt-5" }],
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://custom-proxy.example.com/v1",
            apiKey: "sk-proxy-key",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeDefined();
    expect(result!.OPENAI_API_KEY).toBe("sk-proxy-key");
    expect(result!.OPENAI_BASE_URL).toBe("https://custom-proxy.example.com/v1");
  });

  it("normalizes volcengine-plan to volcengine for auth lookup", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "volcengine-plan/deepseek-v3" }],
      },
      models: {
        providers: {
          volcengine: {
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            apiKey: "volc-key-123",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeDefined();
    expect(result!.VOLCANO_ENGINE_API_KEY).toBe("volc-key-123");
  });

  it("sets all env var candidates for providers with multiple candidates", () => {
    const cfg = makeConfig({
      agents: {
        list: [{ id: "my-agent", model: "github-copilot/gpt-5" }],
      },
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://api.github.com/copilot",
            apiKey: "ghp-copilot-token",
            models: [],
          },
        },
      },
    });

    const result = resolveAcpSpawnAgentEnv({ cfg, agentId: "my-agent" });
    expect(result).toBeDefined();
    // github-copilot has: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN
    expect(result!.COPILOT_GITHUB_TOKEN).toBe("ghp-copilot-token");
    expect(result!.GH_TOKEN).toBe("ghp-copilot-token");
    expect(result!.GITHUB_TOKEN).toBe("ghp-copilot-token");
  });
});
