import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectProviderToolSchemasWithPlugin: vi.fn(),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: mocks.inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

const { logProviderToolSchemaDiagnostics, normalizeProviderToolSchemas } =
  await import("./tool-schema-runtime.js");

describe("tool schema runtime diagnostics", () => {
  beforeEach(() => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
  });

  it("stays quiet when a provider reports no diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("passes through provider runtime loading policy for normalization", () => {
    const tools = [{ name: "alpha" }] as never;
    const runtimeHandle = { provider: "example", plugin: { id: "example-plugin" } } as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockReturnValueOnce(tools);

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    ).toBe(tools);

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "example",
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("logs one summarized warning for provider tool schema diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      { toolName: "alpha", toolIndex: 0, violations: ["one", "two"] },
      { toolName: "beta", toolIndex: 1, violations: ["one"] },
    ]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 2 tools for example: alpha (2 violations), beta (1 violation)",
      {
        provider: "example",
        toolCount: 2,
        diagnosticCount: 2,
        tools: ["0:alpha", "1:beta"],
        diagnostics: [
          { index: 0, tool: "alpha", violations: ["one", "two"], violationCount: 2 },
          { index: 1, tool: "beta", violations: ["one"], violationCount: 1 },
        ],
      },
    );
  });

  it("logs provider diagnostics without rereading unreadable tool names", () => {
    const unreadableName = {};
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("tool name getter exploded");
      },
    });
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      { toolName: "tool[0]", toolIndex: 0, violations: ["tool[0].name is unreadable"] },
    ]);

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [unreadableName] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 1 tool for example: tool[0] (1 violation)",
      {
        provider: "example",
        toolCount: 1,
        diagnosticCount: 1,
        tools: ["0:tool[0]"],
        diagnostics: [
          {
            index: 0,
            tool: "tool[0]",
            violations: ["tool[0].name is unreadable"],
            violationCount: 1,
          },
        ],
      },
    );
  });
});
