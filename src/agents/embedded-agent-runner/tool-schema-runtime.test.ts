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

function createHostileThrownValue() {
  return new Proxy(() => undefined, {
    get(target, property, receiver) {
      if (property === Symbol.toStringTag) {
        throw new Error("tag exploded");
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as Error;
}

describe("tool schema runtime diagnostics", () => {
  beforeEach(() => {
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
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

  it("keeps the current runtime tools when provider schema normalization throws", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("bad\nnormalizer");
    });

    expect(
      normalizeProviderToolSchemas({
        provider: "fuzz-provider\nWARN forged",
        tools,
        hookFailureMode: "warn",
      }),
    ).toBe(tools);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema normalizeToolSchemas hook failed for fuzz-providerWARN forged; keeping current runtime tools: badnormalizer",
      {
        provider: "fuzz-providerWARN forged",
        hookName: "normalizeToolSchemas",
        toolCount: 1,
      },
    );
  });

  it("does not crash warn-mode normalization for hostile thrown values", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw createHostileThrownValue();
    });

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        hookFailureMode: "warn",
      }),
    ).toBe(tools);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema normalizeToolSchemas hook failed for example; keeping current runtime tools: [object Function]",
      {
        provider: "example",
        hookName: "normalizeToolSchemas",
        toolCount: 1,
      },
    );
  });

  it("keeps doctor-style schema normalization strict by default", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("bad normalizer");
    });

    expect(() =>
      normalizeProviderToolSchemas({
        provider: "example",
        tools: [{ name: "alpha" }] as never,
      }),
    ).toThrow("bad normalizer");
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

  it("does not crash runtime diagnostics when provider schema inspection throws", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("bad inspector");
    });

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }] as never,
      hookFailureMode: "warn",
    });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema inspectToolSchemas hook failed for example; keeping current runtime tools: bad inspector",
      {
        provider: "example",
        hookName: "inspectToolSchemas",
        toolCount: 1,
      },
    );
  });

  it("keeps doctor-style schema inspection strict by default", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("bad inspector");
    });

    expect(() =>
      logProviderToolSchemaDiagnostics({
        provider: "example",
        tools: [{ name: "alpha" }] as never,
      }),
    ).toThrow("bad inspector");
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});
