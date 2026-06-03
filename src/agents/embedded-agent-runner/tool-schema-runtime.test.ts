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
    vi.clearAllMocks();
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

  it("keeps original tools when provider schema normalization throws", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("normalizer exploded");
    });

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
      }),
    ).toBe(tools);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema normalization failed for example; keeping original tool schemas",
      { provider: "example", toolCount: 1, error: "normalizer exploded" },
    );
  });

  it("rethrows provider schema normalization errors when requested", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("normalizer exploded");
    });

    expect(() =>
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        throwOnProviderToolSchemaError: true,
      }),
    ).toThrow("normalizer exploded");

    expect(mocks.log.warn).not.toHaveBeenCalled();
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

  it("does not throw when provider schema diagnostics throw or are malformed", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("inspector exploded");
    });

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [{ name: "alpha" }] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics failed for example",
      { provider: "example", toolCount: 1, error: "inspector exploded" },
    );

    const malformedDiagnostics = [
      {
        get toolName() {
          throw new Error("tool name exploded");
        },
        get violations() {
          throw new Error("violations exploded");
        },
      },
    ];
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce(malformedDiagnostics);

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [{ name: "alpha" }] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenLastCalledWith(
      "provider tool schema diagnostics: 1 tool for example: unknown (1 violation)",
      {
        provider: "example",
        toolCount: 1,
        diagnosticCount: 1,
        tools: ["0:alpha"],
        diagnostics: [
          {
            index: undefined,
            tool: "unknown",
            violations: ["diagnostic is unreadable"],
            violationCount: 1,
          },
        ],
      },
    );
  });
});
