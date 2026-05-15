import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

describe("resolveModelRuntimePolicy", () => {
  it("honors provider wildcard agent model runtime policy entries", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "pi" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "pi" },
      source: "model",
    });
  });

  it("prefers exact agent model runtime policy entries over provider wildcards", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "pi" } },
            "vllm/qwen-local": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "model",
    });
  });

  it("prefers exact provider model runtime policy over agent provider wildcards", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "pi" } },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            models: [{ id: "qwen-local", agentRuntime: { id: "codex" } }],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "model",
    });
  });

  it("prefers agent provider wildcard runtime policy over provider runtime policy", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "pi" } },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "pi" },
      source: "model",
    });
  });
});
