import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveCodexCatalogCreateSession } from "./session-catalog-create.js";

const modelConfig = { resolveAllowedModelRef, resolveDefaultModelForAgent };

function configWithAllowedModels(models: string[], runtime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: models[0] },
        models: Object.fromEntries(
          models.map((model) => [model, runtime ? { agentRuntime: { id: runtime } } : {}]),
        ),
      },
    },
  };
}

describe("resolveCodexCatalogCreateSession", () => {
  it("advertises the canonical implicit Codex default", () => {
    expect(resolveCodexCatalogCreateSession(modelConfig, {}, "main")).toEqual({
      model: "openai/gpt-6-astra",
      agentRuntime: "codex",
    });
  });

  it("preserves an existing Sol selection under an unchanged Sol-only policy", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": {} },
          modelPolicy: { allow: ["openai/gpt-5.6-sol"] },
        },
      },
    };
    const before = structuredClone(config);

    expect(resolveCodexCatalogCreateSession(modelConfig, config, "main")).toEqual({
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
    });
    expect(config).toEqual(before);
  });

  it("pins the Codex model even when ordinary chats use the direct runtime", () => {
    expect(
      resolveCodexCatalogCreateSession(
        modelConfig,
        configWithAllowedModels(["openai/gpt-6-astra"], "openclaw"),
        "main",
      ),
    ).toEqual({
      model: "openai/gpt-6-astra",
      agentRuntime: "codex",
    });
  });

  it("does not advertise creation when the Codex model is outside the allowlist", () => {
    expect(
      resolveCodexCatalogCreateSession(
        modelConfig,
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-6" },
              modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
            },
          },
        },
        "main",
      ),
    ).toBeUndefined();
  });

  it("uses the requested agent's model allowlist", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-6-astra" },
          models: { "openai/gpt-6-astra": {} },
        },
        list: [
          { id: "main", default: true },
          {
            id: "research",
            model: { primary: "openai/gpt-5.6-luna" },
            models: { "openai/gpt-5.6-luna": {} },
            modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveCodexCatalogCreateSession(modelConfig, config, "main")).toEqual({
      model: "openai/gpt-6-astra",
      agentRuntime: "codex",
    });
    expect(resolveCodexCatalogCreateSession(modelConfig, config, "research")).toEqual({
      model: "openai/gpt-5.6-luna",
      agentRuntime: "codex",
    });
  });

  it("uses Astra for Codex creation when ordinary chats use another provider", () => {
    expect(
      resolveCodexCatalogCreateSession(
        modelConfig,
        configWithAllowedModels(["anthropic/claude-sonnet-4-6", "openai/gpt-6-astra"]),
        "main",
      ),
    ).toEqual({ model: "openai/gpt-6-astra", agentRuntime: "codex" });
  });

  it("does not advertise creation before runtime config is available", () => {
    expect(resolveCodexCatalogCreateSession(modelConfig, undefined, "main")).toBeUndefined();
  });
});
