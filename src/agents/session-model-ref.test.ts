import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionModelIdentityRef, resolveSessionModelRef } from "./session-model-ref.js";

function modelConfig(primary: string, models?: Record<string, object>): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary }, ...(models ? { models } : {}) },
      entries: { main: {} },
    },
  } as OpenClawConfig;
}

describe("resolveSessionModelRef", () => {
  const runtime = { modelProvider: "openai", model: "gpt-5.4" };
  test.each([
    [
      "complete override",
      { providerOverride: "openrouter", modelOverride: "moonshotai/kimi-k2.5" },
      "main",
      "openrouter",
      "moonshotai/kimi-k2.5",
    ],
    ["current default", {}, "main", "anthropic", "claude-opus-4-6"],
    ["legacy runtime identity", {}, undefined, "openai", "gpt-5.4"],
    [
      "model-only override",
      { modelOverride: "claude-haiku-4-5" },
      "main",
      "anthropic",
      "claude-haiku-4-5",
    ],
  ] as const)("selects %s", (_name, override, agentId, provider, model) => {
    const cfg = modelConfig("anthropic/claude-opus-4-6");
    expect(resolveSessionModelRef(cfg, { ...runtime, ...override }, agentId)).toEqual({
      provider,
      model,
    });
  });
});

describe("resolveSessionModelIdentityRef", () => {
  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = modelConfig("google-gemini-cli/gemini-3.1-pro-preview");
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    expect(
      resolveSessionModelIdentityRef(cfg, {
        model: "qwen-max",
      }),
    ).toEqual({ model: "qwen-max" });
  });

  test.each([false, true])(
    "resolves slash-prefixed identity with wrapper allowlist: %s",
    (wrapped) => {
      const model = "anthropic/claude-sonnet-4-6";
      const cfg = modelConfig(
        "google-gemini-cli/gemini-3.1-pro-preview",
        wrapped ? { [`vercel-ai-gateway/${model}`]: {} } : undefined,
      );
      expect(resolveSessionModelIdentityRef(cfg, { model })).toEqual(
        wrapped
          ? { provider: "vercel-ai-gateway", model }
          : { provider: "anthropic", model: "claude-sonnet-4-6" },
      );
    },
  );
});
