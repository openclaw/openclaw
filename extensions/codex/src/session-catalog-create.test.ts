import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveCodexCatalogCreateSession } from "./session-catalog-create.js";

const modelConfig = { resolveAllowedModelRef, resolveDefaultModelForAgent };

describe("resolveCodexCatalogCreateSession", () => {
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
        entries: {
          main: {},
          research: {
            model: { primary: "openai/gpt-5.6-luna" },
            models: { "openai/gpt-5.6-luna": {} },
            modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
          },
        },
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

  it("does not advertise creation before runtime config is available", () => {
    expect(resolveCodexCatalogCreateSession(modelConfig, undefined, "main")).toBeUndefined();
  });
});
