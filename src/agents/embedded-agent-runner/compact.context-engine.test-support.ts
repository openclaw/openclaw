import { vi, type Mock } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";

export const contextEngineCompactMock: Mock<ContextEngine["compact"]> = vi.fn(async () => ({
  ok: true as boolean,
  compacted: true as boolean,
  reason: undefined as string | undefined,
  result: { summary: "engine-summary", tokensBefore: 120, tokensAfter: 50 },
}));

export const resolveContextEngineMock = vi.fn(async () => ({
  info: { ownsCompaction: true as boolean },
  compact: contextEngineCompactMock,
}));

export function mockCompactContextEngineRegistry(real = false): void {
  if (real) {
    vi.doUnmock("../../context-engine/registry.js");
    return;
  }
  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: resolveContextEngineMock,
    resolveContextEngineOwnerPluginId: vi.fn(() => "lossless-claw"),
    resolveLogicalTurnContextEngines: async () => {
      const engine = await resolveContextEngineMock();
      const ref = { engine, registeredId: "legacy" };
      return { configured: ref, configuredId: "legacy", fallback: ref };
    },
  }));
}
