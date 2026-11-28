import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { resolveEmitsReasoningInContent } from "./model-reasoning-compat.js";

function row(id: string, compat?: ModelDefinitionConfig["compat"]): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(compat ? { compat } : {}),
  };
}

const cfg: OpenClawConfig = {
  models: {
    providers: {
      "local-endpoint": {
        baseUrl: "https://llm.example.test/v1",
        models: [
          row("reasoning-in-content", { emitsReasoningInContent: true }),
          row("separate-reasoning"),
          row("explicit-off", { emitsReasoningInContent: false }),
        ],
      },
    },
  },
};

describe("resolveEmitsReasoningInContent", () => {
  it("opts in for the flagged provider/model row", () => {
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "reasoning-in-content")).toBe(
      true,
    );
  });

  it("matches model ids case-insensitively", () => {
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "REASONING-IN-CONTENT")).toBe(
      true,
    );
  });

  it("stays off for rows without the flag or with it disabled", () => {
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "separate-reasoning")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "explicit-off")).toBe(false);
  });

  it("resolves self-provider-prefixed row ids", () => {
    const prefixed: OpenClawConfig = {
      models: {
        providers: {
          "local-endpoint": {
            baseUrl: "https://llm.example.test/v1",
            models: [row("local-endpoint/prefixed-row", { emitsReasoningInContent: true })],
          },
        },
      },
    };
    expect(resolveEmitsReasoningInContent(prefixed, "local-endpoint", "prefixed-row")).toBe(true);
  });

  it("returns false for unknown providers, models, or empty input", () => {
    expect(resolveEmitsReasoningInContent(cfg, "unknown", "reasoning-in-content")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "unknown-model")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "", "reasoning-in-content")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "local-endpoint", "")).toBe(false);
    const empty: OpenClawConfig = {};
    expect(resolveEmitsReasoningInContent(empty, "local-endpoint", "reasoning-in-content")).toBe(
      false,
    );
  });
});
