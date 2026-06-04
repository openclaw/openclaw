// Runtime plan tool-diagnostics tests cover the legacy provider diagnostic path
// used when no runtime plan owns tool schema diagnostics.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn((params: { tools: unknown[] }) => params.tools),
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("../embedded-agent-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: mocks.logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas: mocks.normalizeProviderToolSchemas,
}));

vi.mock("../embedded-agent-runner/logger.js", () => ({
  log: mocks.log,
}));

const { logAgentRuntimeToolDiagnostics } = await import("./tools.js");

describe("AgentRuntimePlan tool diagnostics legacy fallback", () => {
  it("falls back to provider diagnostics when no RuntimePlan is available", () => {
    const tools = [{ name: "alpha" }] as never;

    logAgentRuntimeToolDiagnostics({
      tools,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
    });

    expect(mocks.logProviderToolSchemaDiagnostics).toHaveBeenCalledTimes(1);
    expect(mocks.logProviderToolSchemaDiagnostics.mock.calls.at(0)?.[0]).toEqual({
      tools,
      provider: "openai",
      config: undefined,
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      env: process.env,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: undefined,
    });
  });

  it("warns instead of crashing when RuntimePlan diagnostics throw", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("tools length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    }) as never;
    const logDiagnostics = vi.fn(() => {
      throw new Error("runtime plan inspector exploded");
    });

    expect(() =>
      logAgentRuntimeToolDiagnostics({
        runtimePlan: {
          tools: {
            normalize: vi.fn(),
            logDiagnostics,
          },
        } as never,
        tools,
        provider: "openai",
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "runtime plan tool schema diagnostics failed for openai: runtime plan inspector exploded",
      {
        provider: "openai",
        toolCount: 0,
      },
    );
  });
});
