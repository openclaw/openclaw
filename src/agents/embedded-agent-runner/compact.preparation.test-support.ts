import { vi, type Mock } from "vitest";

type PreparationMocks = {
  applyExtraParamsToAgent: typeof import("./compact.hooks.harness.js").applyExtraParamsToAgentMock;
  resolveAgentTransportOverride: Mock<(params?: unknown) => string | undefined>;
  buildEmbeddedExtensionFactories: typeof import("./extensions.js").buildEmbeddedExtensionFactories;
};

/** Keep prepared-runtime module registration together; factories remain lazy. */
export function mockCompactionPreparation(
  options: { durableSession?: boolean },
  bindings: PreparationMocks,
): void {
  vi.doMock("./extra-params.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./extra-params.js")>()),
    applyExtraParamsToAgent: bindings.applyExtraParamsToAgent,
    resolveAgentTransportOverride: bindings.resolveAgentTransportOverride,
    resolvePreparedExtraParams: vi.fn(() => ({})),
  }));

  // mock-isolation: Hook fixtures pin factories; durable fixtures retain the real builtin selector.
  vi.doMock("./extensions.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./extensions.js")>();
    return {
      ...actual,
      buildEmbeddedExtensionFactories: bindings.buildEmbeddedExtensionFactories,
      ...(!options.durableSession
        ? { resolveEmbeddedCompactionSafeguard: vi.fn(() => undefined) }
        : {}),
    };
  });
}
