// Tool schema runtime tests cover provider plugin schema normalization and
// compact diagnostics for invalid provider-facing tool schemas.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Hoisted mocks let the module under test import logger/provider runtime once
  // while each case controls plugin diagnostics.
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

  it("logs provider diagnostics when source tool names are unreadable", () => {
    const unreadable = { name: "unreadable" };
    Object.defineProperty(unreadable, "name", {
      enumerable: true,
      get(): string {
        throw new Error("provider diagnostics tool name getter exploded");
      },
    });
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      {
        toolName: "fuzzplugin_move_angles",
        toolIndex: 0,
        violations: ["unsupported dynamic schema"],
      },
    ]);

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [unreadable, { name: "healthy" }] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 1 tool for example: fuzzplugin_move_angles (1 violation)",
      expect.objectContaining({
        tools: ["0:tool[0]", "1:healthy"],
      }),
    );
  });

  it("logs provider inspection failures without throwing", () => {
    const unreadable = { name: "unreadable" };
    Object.defineProperty(unreadable, "name", {
      enumerable: true,
      get(): string {
        throw new Error("provider diagnostics tool name getter exploded");
      },
    });
    mocks.inspectProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("provider inspector exploded");
    });

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [unreadable, { name: "healthy" }] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics failed for example: provider inspector exploded",
      {
        provider: "example",
        toolCount: 2,
        tools: ["0:tool[0]", "1:healthy"],
      },
    );
  });

  it("logs provider diagnostics when diagnostic descriptors are unreadable", () => {
    const diagnostic = { toolIndex: 0, toolName: "fuzzplugin_move_angles", violations: ["one"] };
    Object.defineProperty(diagnostic, "toolName", {
      enumerable: true,
      get(): string {
        throw new Error("provider diagnostic tool name getter exploded");
      },
    });
    Object.defineProperty(diagnostic, "violations", {
      enumerable: true,
      get(): string[] {
        throw new Error("provider diagnostic violations getter exploded");
      },
    });
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([diagnostic]);

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [{ name: "healthy" }] as never,
      }),
    ).not.toThrow();

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 1 tool for example: tool[0] (1 violation)",
      expect.objectContaining({
        diagnostics: [
          {
            index: 0,
            tool: "tool[0]",
            violations: ["diagnostic violations unreadable"],
            violationCount: 1,
          },
        ],
      }),
    );
  });
});
